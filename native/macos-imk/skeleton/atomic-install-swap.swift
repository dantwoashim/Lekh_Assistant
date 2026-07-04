import Darwin
import Foundation

private let renameSwapFlag: UInt32 = 0x00000002

guard CommandLine.arguments.count == 3 else {
  FileHandle.standardError.write(Data("usage: atomic-install-swap <new-path> <installed-path>\n".utf8))
  exit(64)
}

let newPath = CommandLine.arguments[1]
let installedPath = CommandLine.arguments[2]
let fileManager = FileManager.default

guard fileManager.fileExists(atPath: newPath) else {
  FileHandle.standardError.write(Data("new path does not exist: \(newPath)\n".utf8))
  exit(66)
}

guard fileManager.fileExists(atPath: installedPath) else {
  FileHandle.standardError.write(Data("installed path does not exist: \(installedPath)\n".utf8))
  exit(66)
}

let result = newPath.withCString { newCString in
  installedPath.withCString { installedCString in
    renamex_np(newCString, installedCString, renameSwapFlag)
  }
}

if result != 0 {
  let error = errno
  let message = String(cString: strerror(error))
  FileHandle.standardError.write(Data("atomic swap failed: \(message) (\(error))\n".utf8))
  exit(74)
}
