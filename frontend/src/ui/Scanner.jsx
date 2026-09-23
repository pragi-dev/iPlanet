import { useEffect, useRef, useState } from 'react';
import { Keyboard } from 'lucide-react';
import { Button, InlineAlert } from './primitives';
import { Modal } from './overlay';

// Camera barcode / QR scanning via the browser BarcodeDetector API. Manual
// serial entry remains available whenever scanning is unsupported.
export function Scanner({ onDetected, onClose, title = 'Scan device serial number' }) {
  const videoRef = useRef(null);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(true);
  useEffect(() => {
    let stream;
    let timer;
    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        if (!('BarcodeDetector' in window)) { setError('Camera scanning is not supported in this browser. Enter the serial number manually.'); return; }
        const detector = new window.BarcodeDetector({ formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'upc_a'] });
        const scan = async () => {
          if (!scanning || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes[0]?.rawValue) { setScanning(false); onDetected(codes[0].rawValue); return; }
          } catch { /* Continue scanning unavailable frames. */ }
          timer = window.setTimeout(scan, 300);
        };
        void scan();
      } catch {
        setError('Camera permission is unavailable. Enter the serial number manually.');
      }
    };
    void start();
    return () => { if (timer) window.clearTimeout(timer); stream?.getTracks().forEach(track => track.stop()); };
  }, [onDetected, scanning]);
  return <Modal title={error ? 'Manual entry recommended' : title} eyebrow="Barcode / QR scan" onClose={onClose} footer={<Button icon={Keyboard} onClick={onClose}>Enter serial manually</Button>}>
    {error ? <InlineAlert tone="warning" title={error} /> : <>
      <div className="scanner-frame"><video ref={videoRef} className="scanner-video" playsInline muted aria-label="Camera preview" /></div>
      <p className="text-muted text-small">Hold the serial number barcode or QR code inside the frame. It is detected automatically.</p>
    </>}
  </Modal>;
}
