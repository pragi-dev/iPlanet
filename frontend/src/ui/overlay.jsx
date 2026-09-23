import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

let activeLayers = 0;
let savedBodyStyles;
const escapeStack = [];

// Overlays render into document.body so `position: fixed; inset: 0` always
// targets the viewport, independent of any layout overflow, transform or
// stacking context in the page.
export function ModalLayer({ children, className = 'overlay', onDismiss, labelledBy, label }) {
  const rootRef = useRef(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useLayoutEffect(() => {
    const { body, documentElement } = document;
    if (activeLayers === 0) {
      savedBodyStyles = { overflow: body.style.overflow, paddingRight: body.style.paddingRight };
      const scrollbarWidth = window.innerWidth - documentElement.clientWidth;
      body.style.overflow = 'hidden';
      if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;
    }
    activeLayers += 1;
    return () => {
      activeLayers -= 1;
      if (activeLayers === 0 && savedBodyStyles) {
        body.style.overflow = savedBodyStyles.overflow;
        body.style.paddingRight = savedBodyStyles.paddingRight;
        savedBodyStyles = undefined;
      }
    };
  }, []);

  // Escape closes only the top-most layer; focus returns to the trigger.
  useEffect(() => {
    const token = {};
    escapeStack.push(token);
    const previous = document.activeElement;
    const root = rootRef.current;
    const focusable = root?.querySelector('[data-autofocus]')
      || root?.querySelector('.modal-body input:not([type=hidden]):not([disabled]), .modal-body select, .modal-body textarea')
      || root?.querySelector('.modal-body button:not([disabled]), .drawer-body button:not([disabled])');
    (focusable || root)?.focus?.({ preventScroll: true });
    const onKeyDown = event => {
      if (escapeStack[escapeStack.length - 1] !== token) return;
      if (event.key === 'Escape' && dismissRef.current) { event.stopPropagation(); dismissRef.current(); }
      if (event.key === 'Tab' && root) {
        const items = [...root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(item => item.offsetParent !== null);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const index = escapeStack.indexOf(token);
      if (index >= 0) escapeStack.splice(index, 1);
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div className={className} ref={rootRef} tabIndex={-1} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) dismissRef.current?.(); }} aria-labelledby={labelledBy} aria-label={label}>
      {children}
    </div>,
    document.body,
  );
}

export function Modal({ title, eyebrow, description, onClose, children, footer, size = 'md', as: Element = 'div', onSubmit, className = '' }) {
  const titleId = useId();
  return <ModalLayer className="overlay overlay-center" onDismiss={onClose}>
    <Element className={`modal modal-${size} ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={onSubmit}>
      <header className="modal-header">
        <div>
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h2 id={titleId} className="modal-title">{title}</h2>
          {description && <p className="modal-description">{description}</p>}
        </div>
        <button type="button" className="icon-button ghost" aria-label="Close dialog" onClick={onClose}><X size={18} /></button>
      </header>
      {children && <div className="modal-body">{children}</div>}
      {footer && <footer className="modal-footer">{footer}</footer>}
    </Element>
  </ModalLayer>;
}

export function ConfirmDialog({ title, description, confirmLabel = 'Confirm', tone = 'primary', busy = false, onConfirm, onClose, children }) {
  return <Modal size="sm" title={title} description={description} onClose={onClose}
    footer={<>
      <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button type="button" className={`btn btn-${tone === 'danger' ? 'danger' : 'primary'}`} disabled={busy} onClick={onConfirm} data-autofocus>{busy ? 'Working…' : confirmLabel}</button>
    </>}>
    {children}
  </Modal>;
}

export function Drawer({ title, eyebrow, icon, onClose, children, footer, actions, width = 420, className = '', label }) {
  const titleId = useId();
  return <ModalLayer className="overlay overlay-drawer" onDismiss={onClose}>
    <aside className={`drawer ${className}`} style={{ '--drawer-width': `${width}px` }} role="dialog" aria-modal="true" aria-labelledby={label ? undefined : titleId} aria-label={label}>
      <header className="drawer-header">
        <div className="drawer-heading">
          {icon && <span className="drawer-icon">{icon}</span>}
          <div>
            <h2 id={titleId} className="drawer-title">{title}</h2>
            {eyebrow && <p className="drawer-subtitle">{eyebrow}</p>}
          </div>
        </div>
        <div className="drawer-actions">
          {actions}
          <button type="button" className="icon-button ghost" aria-label="Close panel" onClick={onClose}><X size={18} /></button>
        </div>
      </header>
      <div className="drawer-body">{children}</div>
      {footer && <footer className="drawer-footer">{footer}</footer>}
    </aside>
  </ModalLayer>;
}

export function Lightbox({ src, alt = 'Attachment preview', onClose }) {
  return <ModalLayer className="overlay overlay-center lightbox" onDismiss={onClose} label={alt}>
    <div className="lightbox-frame" role="dialog" aria-modal="true" aria-label={alt}>
      <button type="button" className="icon-button lightbox-close" aria-label="Close image preview" onClick={onClose}><X size={20} /></button>
      <img src={src} alt={alt} />
    </div>
  </ModalLayer>;
}
