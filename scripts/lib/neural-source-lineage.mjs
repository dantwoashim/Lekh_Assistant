import { createHash } from "node:crypto";

const splitPriority = Object.freeze({ train: 1, dev: 2, test: 3 });
const splitForPriority = Object.freeze([null, "train", "dev", "test"]);

export class LeakageSafeSplitPlanner {
  #inputNodes = new Map();
  #targetNodes = new Map();
  #parent = [];
  #rank = [];
  #priority = [];
  #stableSplitForInput;

  constructor(stableSplitForInput) {
    if (typeof stableSplitForInput !== "function") {
      throw new TypeError("LeakageSafeSplitPlanner requires a stable input split function.");
    }
    this.#stableSplitForInput = stableSplitForInput;
  }

  add(input, target, requestedSplit) {
    const normalizedInput = String(input);
    const resolvedRequest = splitPriority[requestedSplit]
      ? requestedSplit
      : this.#stableSplitForInput(normalizedInput);
    if (!splitPriority[resolvedRequest]) {
      throw new TypeError(`Unsupported neural split: ${resolvedRequest}`);
    }

    const inputNode = this.#ensure(this.#inputNodes, normalizedInput);
    let root = this.#find(inputNode);
    if (target !== null && target !== undefined) {
      const targetNode = this.#ensure(this.#targetNodes, String(target));
      root = this.#union(root, targetNode);
    }
    this.#priority[root] = Math.max(this.#priority[root] ?? 0, splitPriority[resolvedRequest]);
    return resolvedRequest;
  }

  splitFor(input) {
    const inputNode = this.#inputNodes.get(String(input));
    if (inputNode === undefined) {
      throw new TypeError(`No neural split component was registered for input: ${input}`);
    }
    return splitForPriority[this.#priority[this.#find(inputNode)] ?? 0];
  }

  #ensure(nodes, identity) {
    const existing = nodes.get(identity);
    if (existing !== undefined) return existing;
    const node = this.#parent.length;
    nodes.set(identity, node);
    this.#parent.push(node);
    this.#rank.push(0);
    this.#priority.push(0);
    return node;
  }

  #find(node) {
    const parent = this.#parent[node];
    if (parent !== node) this.#parent[node] = this.#find(parent);
    return this.#parent[node];
  }

  #union(leftNode, rightNode) {
    let left = this.#find(leftNode);
    let right = this.#find(rightNode);
    if (left === right) return left;

    const leftRank = this.#rank[left] ?? 0;
    const rightRank = this.#rank[right] ?? 0;
    if (leftRank < rightRank) [left, right] = [right, left];
    this.#parent[right] = left;
    if (leftRank === rightRank) this.#rank[left] = leftRank + 1;
    this.#priority[left] = Math.max(this.#priority[left] ?? 0, this.#priority[right] ?? 0);
    this.#priority[right] = 0;
    return left;
  }
}

export function selectAksharantarRows(candidates, trainCap = null) {
  if (!Array.isArray(candidates)) throw new TypeError("Aksharantar candidates must be an array.");
  if (trainCap !== null && (!Number.isInteger(trainCap) || trainCap < 1)) {
    throw new TypeError("Aksharantar train cap must be a positive integer or null.");
  }

  const heldOut = [];
  const train = trainCap === null ? [] : null;
  const cappedTrain = trainCap === null ? null : new DeterministicTrainCapSelector(trainCap);
  let availableTrainRows = 0;
  for (const candidate of candidates) {
    if (!["train", "validation", "test"].includes(candidate.upstreamSplit)) {
      throw new TypeError(`Unsupported Aksharantar upstream split: ${candidate.upstreamSplit}`);
    }
    if (candidate.upstreamSplit === "validation" || candidate.upstreamSplit === "test") heldOut.push(candidate);
    else {
      availableTrainRows += 1;
      if (train !== null) train.push(candidate);
      else cappedTrain.add(candidate);
    }
  }

  const selectedTrain = train ?? cappedTrain.selected();
  return Object.freeze({
    heldOut: Object.freeze([...heldOut]),
    selectedTrain: Object.freeze([...selectedTrain]),
    selectedRows: Object.freeze([...heldOut, ...selectedTrain]),
    availableTrainRows,
    heldOutRows: heldOut.length,
    omittedTrainRows: availableTrainRows - selectedTrain.length
  });
}

export class DeterministicTrainCapSelector {
  #cap;
  #heap = [];

  constructor(cap) {
    if (!Number.isInteger(cap) || cap < 1) {
      throw new TypeError("Deterministic train cap must be a positive integer.");
    }
    this.#cap = cap;
  }

  add(candidate) {
    const item = decorateSelectionCandidate(candidate);
    if (this.#heap.length < this.#cap) {
      this.#heap.push(item);
      this.#siftUp(this.#heap.length - 1);
    } else if (compareDecoratedSelection(item, this.#heap[0]) < 0) {
      this.#heap[0] = item;
      this.#siftDown(0);
    }
  }

  selected() {
    return [...this.#heap]
      .sort(compareDecoratedSelection)
      .map(({ candidate }) => candidate);
  }

  #siftUp(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareDecoratedSelection(this.#heap[parent], this.#heap[index]) >= 0) break;
      [this.#heap[parent], this.#heap[index]] = [this.#heap[index], this.#heap[parent]];
      index = parent;
    }
  }

  #siftDown(index) {
    for (;;) {
      const left = (index * 2) + 1;
      const right = left + 1;
      let largest = index;
      if (left < this.#heap.length && compareDecoratedSelection(this.#heap[left], this.#heap[largest]) > 0) {
        largest = left;
      }
      if (right < this.#heap.length && compareDecoratedSelection(this.#heap[right], this.#heap[largest]) > 0) {
        largest = right;
      }
      if (largest === index) return;
      [this.#heap[index], this.#heap[largest]] = [this.#heap[largest], this.#heap[index]];
      index = largest;
    }
  }
}

export function novelSourceIdsForLineages(existingSourceIds, candidateSourceIds, sourceById) {
  const seenLineages = new Set(existingSourceIds.map((sourceId) => lineageFor(sourceId, sourceById)));
  const novel = [];
  for (const sourceId of [...new Set(candidateSourceIds.map(String))].sort()) {
    const lineage = lineageFor(sourceId, sourceById);
    if (seenLineages.has(lineage)) continue;
    seenLineages.add(lineage);
    novel.push(sourceId);
  }
  return novel;
}

function lineageFor(sourceId, sourceById) {
  const source = sourceById.get(sourceId);
  return String(source?.lineageId ?? sourceId);
}

function decorateSelectionCandidate(candidate) {
  const identity = selectionIdentity(candidate);
  return {
    candidate,
    identity,
    hash: createHash("sha256").update(identity).digest("hex")
  };
}

function compareDecoratedSelection(left, right) {
  return compareStrings(left.hash, right.hash) || compareStrings(left.identity, right.identity);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function selectionIdentity(candidate) {
  return [candidate.input, candidate.target, candidate.upstreamId ?? "", candidate.upstreamSource ?? ""]
    .map((value) => String(value ?? ""))
    .join("\0");
}
