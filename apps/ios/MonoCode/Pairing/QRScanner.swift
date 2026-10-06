import AVFoundation
import SwiftUI
import Vision
import VisionKit

/// VisionKit's `DataScannerViewController`, recognising QR codes only
/// (04 §4.7). Shown only where `isSupported`; the simulator is not.
struct QRScanner: UIViewControllerRepresentable {
  /// Called with each QR payload; the sheet decides whether it is an offer.
  var found: (String) -> Void

  func makeUIViewController(context: Context) -> DataScannerViewController {
    let scanner = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, recognizesMultipleItems: false,
      isHighFrameRateTrackingEnabled: false, isHighlightingEnabled: true)
    scanner.delegate = context.coordinator
    return scanner
  }

  func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
    context.coordinator.found = found
    if DataScannerViewController.isAvailable, !scanner.isScanning { try? scanner.startScanning() }
  }

  static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
    scanner.stopScanning()
  }

  func makeCoordinator() -> Coordinator { Coordinator(found: found) }

  final class Coordinator: NSObject, DataScannerViewControllerDelegate {
    var found: (String) -> Void
    private var last: String?

    init(found: @escaping (String) -> Void) {
      self.found = found
    }

    func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
      for case let .barcode(code) in items {
        guard let text = code.payloadStringValue, text != last else { continue }
        last = text
        found(text)
        return
      }
    }
  }
}

/// The scanner's torch toggle (11 §11.11).
enum Torch {
  static func set(_ on: Bool) {
    guard let device = AVCaptureDevice.default(for: .video), device.hasTorch else { return }
    try? device.lockForConfiguration()
    device.torchMode = on ? .on : .off
    device.unlockForConfiguration()
  }
}
