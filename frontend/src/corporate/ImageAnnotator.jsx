import { useEffect, useRef, useState } from 'react';
import { Check, Eraser, Undo2 } from 'lucide-react';
import { Button, Modal } from '../ui';

export function ImageAnnotator({ file, onSave, onCancel }) {
  const canvasRef = useRef(null);
  const [history, setHistory] = useState([]);
  const [drawing, setDrawing] = useState(false);
  const [preview, setPreview] = useState('');
  useEffect(() => { if (!file) return undefined; const url = URL.createObjectURL(file); setPreview(url); return () => URL.revokeObjectURL(url); }, [file]);
  useEffect(() => {
    if (!preview || !canvasRef.current) return;
    const image = new Image();
    image.onload = () => {
      const canvas = canvasRef.current;
      const scale = Math.min(1, 760 / image.width);
      canvas.width = image.width * scale;
      canvas.height = image.height * scale;
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      setHistory([canvas.toDataURL('image/png')]);
    };
    image.src = preview;
  }, [preview]);
  const point = event => { const rect = canvasRef.current.getBoundingClientRect(); return { x: (event.clientX - rect.left) * (canvasRef.current.width / rect.width), y: (event.clientY - rect.top) * (canvasRef.current.height / rect.height) }; };
  const start = event => { const ctx = canvasRef.current.getContext('2d'); const { x, y } = point(event); ctx.beginPath(); ctx.moveTo(x, y); ctx.strokeStyle = '#dc2626'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; setDrawing(true); };
  const draw = event => { if (!drawing) return; const ctx = canvasRef.current.getContext('2d'); const { x, y } = point(event); ctx.lineTo(x, y); ctx.stroke(); };
  const stop = () => { if (!drawing) return; setDrawing(false); setHistory(items => [...items, canvasRef.current.toDataURL('image/png')]); };
  const undo = () => { if (history.length < 2) return; const next = history.slice(0, -1); setHistory(next); const image = new Image(); image.onload = () => canvasRef.current.getContext('2d').drawImage(image, 0, 0, canvasRef.current.width, canvasRef.current.height); image.src = next[next.length - 1]; };
  const clear = () => { const image = new Image(); image.onload = () => { const ctx = canvasRef.current.getContext('2d'); ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height); ctx.drawImage(image, 0, 0, canvasRef.current.width, canvasRef.current.height); setHistory([canvasRef.current.toDataURL('image/png')]); }; image.src = preview; };
  const save = () => canvasRef.current.toBlob(blob => onSave(new File([blob], `annotated-${file.name}`, { type: 'image/png' })));
  return <Modal size="lg" eyebrow="Damage annotation" title="Mark the damaged area" description="Draw around the damage so the service team knows exactly where to look. The original photo is kept as well." onClose={onCancel}
    footer={<div className="annotator-toolbar" style={{ width: '100%' }}>
      <Button icon={Undo2} onClick={undo} disabled={history.length < 2}>Undo</Button>
      <Button icon={Eraser} onClick={clear} disabled={history.length < 2}>Reset</Button>
      <span className="spacer" />
      <Button onClick={onCancel}>Cancel</Button>
      <Button variant="primary" icon={Check} onClick={save}>Save annotation</Button>
    </div>}>
    <div className="annotator-canvas-wrap"><canvas ref={canvasRef} aria-label={`Annotation canvas for ${file.name}`} onPointerDown={start} onPointerMove={draw} onPointerUp={stop} onPointerLeave={stop} /></div>
  </Modal>;
}
