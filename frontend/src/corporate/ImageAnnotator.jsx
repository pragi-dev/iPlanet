import { useEffect, useRef, useState } from 'react';
import { Check, Eraser, Undo2, X } from 'lucide-react';
import { ModalLayer } from './ModalLayer';

export function ImageAnnotator({ file, onSave, onCancel }) {
  const canvasRef = useRef(null);
  const [history, setHistory] = useState([]);
  const [drawing, setDrawing] = useState(false);
  const [preview, setPreview] = useState('');
  useEffect(() => { if (!file) return; const url = URL.createObjectURL(file); setPreview(url); return () => URL.revokeObjectURL(url); }, [file]);
  useEffect(() => { if (!preview || !canvasRef.current) return; const image = new Image(); image.onload = () => { const canvas = canvasRef.current; const scale = Math.min(1, 760 / image.width); canvas.width = image.width * scale; canvas.height = image.height * scale; canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height); setHistory([canvas.toDataURL('image/png')]); }; image.src = preview; }, [preview]);
  const point = event => { const rect = canvasRef.current.getBoundingClientRect(); return { x: (event.clientX - rect.left) * (canvasRef.current.width / rect.width), y: (event.clientY - rect.top) * (canvasRef.current.height / rect.height) }; };
  const start = event => { const ctx = canvasRef.current.getContext('2d'); const { x, y } = point(event); ctx.beginPath(); ctx.moveTo(x, y); ctx.strokeStyle = '#e17c4d'; ctx.lineWidth = 4; ctx.lineCap = 'round'; setDrawing(true); };
  const draw = event => { if (!drawing) return; const ctx = canvasRef.current.getContext('2d'); const { x, y } = point(event); ctx.lineTo(x, y); ctx.stroke(); };
  const stop = () => { if (!drawing) return; setDrawing(false); setHistory(items => [...items, canvasRef.current.toDataURL('image/png')]); };
  const undo = () => { if (history.length < 2) return; const next = history.slice(0, -1); setHistory(next); const image = new Image(); image.onload = () => canvasRef.current.getContext('2d').drawImage(image, 0, 0, canvasRef.current.width, canvasRef.current.height); image.src = next[next.length - 1]; };
  const clear = () => { const image = new Image(); image.onload = () => { const ctx = canvasRef.current.getContext('2d'); ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height); ctx.drawImage(image, 0, 0, canvasRef.current.width, canvasRef.current.height); setHistory([canvasRef.current.toDataURL('image/png')]); }; image.src = preview; };
  const save = () => canvasRef.current.toBlob(blob => onSave(new File([blob], `annotated-${file.name}`, { type: 'image/png' })));
  return <ModalLayer className="annotator-backdrop"><div className="annotator panel"><div className="panel-heading"><div><span className="kicker">Damage annotation</span><h3>Mark the damaged area</h3></div><button type="button" className="modal-close" onClick={onCancel}><X size={18} /></button></div><canvas ref={canvasRef} onPointerDown={start} onPointerMove={draw} onPointerUp={stop} onPointerLeave={stop} /><div className="annotator-actions"><button type="button" className="button secondary" onClick={undo}><Undo2 size={15} />Undo</button><button type="button" className="button secondary" onClick={clear}><Eraser size={15} />Reset</button><span className="annotator-spacer" /><button type="button" className="button secondary" onClick={onCancel}>Cancel</button><button type="button" className="button primary" onClick={save}><Check size={15} />Save annotation</button></div></div></ModalLayer>;
}
