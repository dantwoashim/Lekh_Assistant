"use strict";

class PreferenceWriteQueueFullError extends Error {
  constructor(maximumPending) {
    super(`Native preference write queue is full (${maximumPending} pending).`);
    this.name = "PreferenceWriteQueueFullError";
    this.code = "ERR_LEKH_PREFERENCE_QUEUE_FULL";
  }
}

class PreferenceWriteQueueClosedError extends Error {
  constructor() {
    super("Native preference write queue is closed.");
    this.name = "PreferenceWriteQueueClosedError";
    this.code = "ERR_LEKH_PREFERENCE_QUEUE_CLOSED";
  }
}

class BoundedSerialTaskQueue {
  constructor({ maximumPending = 32 } = {}) {
    if (!Number.isSafeInteger(maximumPending) || maximumPending < 1) {
      throw new TypeError("maximumPending must be a positive safe integer.");
    }
    this.maximumPending = maximumPending;
    this.pendingCount = 0;
    this.accepting = true;
    this.tail = Promise.resolve();
    this.drainWaiters = new Set();
  }

  enqueue(task) {
    if (typeof task !== "function") throw new TypeError("Queued task must be a function.");
    if (!this.accepting) throw new PreferenceWriteQueueClosedError();
    if (this.pendingCount >= this.maximumPending) {
      throw new PreferenceWriteQueueFullError(this.maximumPending);
    }

    this.pendingCount += 1;
    const execution = this.tail.then(() => task());
    const settled = execution.finally(() => {
      this.pendingCount -= 1;
      if (this.pendingCount === 0) this.resolveDrainWaiters();
    });
    this.tail = settled.then(
      () => undefined,
      () => undefined
    );
    return settled;
  }

  close() {
    this.accepting = false;
  }

  drain(timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new TypeError("Drain timeout must be a finite non-negative number.");
    }
    if (this.pendingCount === 0) {
      return Promise.resolve({ drained: true, pending: 0 });
    }

    return new Promise((resolve) => {
      let finished = false;
      const finish = (result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.drainWaiters.delete(onDrained);
        resolve(result);
      };
      const onDrained = () => finish({ drained: true, pending: 0 });
      const timer = setTimeout(() => {
        finish({ drained: false, pending: this.pendingCount });
      }, timeoutMs);
      this.drainWaiters.add(onDrained);
      if (this.pendingCount === 0) onDrained();
    });
  }

  resolveDrainWaiters() {
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }
}

function validatePreferencePatch(
  patch,
  { booleanKeys, nativeModes, maximumExcludedApplications = 100 }
) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new TypeError("Invalid preference update.");
  }
  if (!(booleanKeys instanceof Set) || !(nativeModes instanceof Set)) {
    throw new TypeError("Preference validation requires key and mode sets.");
  }
  if (!Number.isSafeInteger(maximumExcludedApplications) || maximumExcludedApplications < 0) {
    throw new TypeError("maximumExcludedApplications must be a non-negative safe integer.");
  }

  const entries = Object.entries(patch);
  if (entries.length === 0 || entries.length > booleanKeys.size + 2) {
    throw new TypeError("Preference update must contain supported values.");
  }
  const validated = {};
  for (const [key, value] of entries) {
    if (key === "nativeTypingMode") {
      if (typeof value !== "string" || !nativeModes.has(value)) {
        throw new TypeError("Invalid native typing mode.");
      }
      validated[key] = value;
      continue;
    }
    if (key === "excludedApplicationBundleIdentifiers") {
      if (!Array.isArray(value) || value.length > maximumExcludedApplications) {
        throw new TypeError("Invalid excluded application list.");
      }
      const identifiers = value.map((item) => {
        if (
          typeof item !== "string"
          || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(item)
        ) {
          throw new TypeError("Excluded applications must be valid bundle identifiers.");
        }
        return item;
      });
      if (new Set(identifiers).size !== identifiers.length) {
        throw new TypeError("Excluded applications must be unique.");
      }
      validated[key] = identifiers;
      continue;
    }
    if (!booleanKeys.has(key) || typeof value !== "boolean") {
      throw new TypeError(`Unsupported preference: ${key}`);
    }
    validated[key] = value;
  }
  return validated;
}

module.exports = {
  BoundedSerialTaskQueue,
  PreferenceWriteQueueClosedError,
  PreferenceWriteQueueFullError,
  validatePreferencePatch
};
