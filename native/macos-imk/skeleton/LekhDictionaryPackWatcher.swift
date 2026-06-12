import Darwin
import Foundation

public final class LekhDictionaryPackWatcher {
  public static let packsDirectory = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library", isDirectory: true)
    .appendingPathComponent("Application Support", isDirectory: true)
    .appendingPathComponent("Lekh Keyboard", isDirectory: true)
    .appendingPathComponent("Packs", isDirectory: true)

  public static let activePackURL = packsDirectory.appendingPathComponent("runtime-suggestions.current.lkb")

  private let queue = DispatchQueue(label: "com.lekh.inputmethod.dictionary-pack-watcher")
  private let onChange: () -> Void
  private var fileDescriptor: CInt = -1
  private var source: DispatchSourceFileSystemObject?

  public init(onChange: @escaping () -> Void) {
    self.onChange = onChange
  }

  deinit {
    stop()
  }

  public func start() {
    guard source == nil else { return }
    try? FileManager.default.createDirectory(at: Self.packsDirectory, withIntermediateDirectories: true)
    fileDescriptor = open(Self.packsDirectory.path, O_EVTONLY)
    guard fileDescriptor >= 0 else { return }
    let eventSource = DispatchSource.makeFileSystemObjectSource(
      fileDescriptor: fileDescriptor,
      eventMask: [.write, .rename, .delete],
      queue: queue
    )
    eventSource.setEventHandler { [weak self] in
      guard let self else { return }
      self.queue.asyncAfter(deadline: .now() + .milliseconds(250)) {
        self.onChange()
      }
    }
    eventSource.setCancelHandler { [weak self] in
      guard let self, self.fileDescriptor >= 0 else { return }
      close(self.fileDescriptor)
      self.fileDescriptor = -1
    }
    source = eventSource
    eventSource.resume()
  }

  public func stop() {
    source?.cancel()
    source = nil
  }
}
