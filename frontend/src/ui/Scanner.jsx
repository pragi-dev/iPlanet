import { useEffect, useRef, useState } from 'react';
import { Keyboard } from 'lucide-react';
import { Button, InlineAlert } from './primitives';
import { Modal } from './overlay';

// Camera barcode / QR scanning via the browser BarcodeDetector API. Manual
// serial entry remains available whenever scanning is unsupported.
export function Scanner({ onDetected, onClose, title = 'Scan device serial number' }) {
  const videoRef = useRef(null);
  const [error, setError] = useState('');
  const onDetectedRef = useRef(onDetected);
  useEffect(() => { onDetectedRef.current = onDetected; }, [onDetected]);
  // Runs once per open. `cancelled` covers the window where the camera permission prompt is
  // still open when the scanner closes: the stream that arrives later is stopped immediately.
  useEffect(() => {
    let stream = null;
    let timer;
    let cancelled = false;
    const stop = () => { if (timer) window.clearTimeout(timer); stream?.getTracks().forEach(track => track.stop()); stream = null; };
    const start = async () => {
      if (!('BarcodeDetector' in window)) { setError('Camera scanning is not supported in this browser. Enter the serial number manually.'); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (cancelled || !videoRef.current) { stop(); return; }
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        const detector = new window.BarcodeDetector({ formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'upc_a'] });
        const scan = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes[0]?.rawValue && !cancelled) { stop(); onDetectedRef.current(codes[0].rawValue); return; }
          } catch { /* Continue scanning unavailable frames. */ }
          timer = window.setTimeout(scan, 300);
        };
        void scan();
      } catch {
        stop();
        if (!cancelled) setError('Camera permission is unavailable. Enter the serial number manually.');
      }
    };
    void start();
    return () => { cancelled = true; stop(); };
  }, []);
  return <Modal title={error ? 'Manual entry recommended' : title} eyebrow="Barcode / QR scan" onClose={onClose} footer={<Button icon={Keyboard} onClick={onClose}>Enter serial manually</Button>}>
    {error ? <InlineAlert tone="warning" title={error} /> : <>
      <div className="scanner-frame"><video ref={videoRef} className="scanner-video" playsInline muted aria-label="Camera preview" /></div>
      <p className="text-muted text-small">Hold the serial number barcode or QR code inside the frame. It is detected automatically.</p>
    </>}
  </Modal>;
}
