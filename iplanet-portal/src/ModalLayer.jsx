import { useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';

let activeModalLayers = 0;
let savedBodyStyles;

// Keep overlays outside application layouts so fixed positioning always targets
// the browser viewport, regardless of a page's stacking or overflow rules.
export function ModalLayer({ children, className = 'modal-backdrop' }) {
  useLayoutEffect(() => {
    const { body, documentElement } = document;
    if (activeModalLayers === 0) {
      savedBodyStyles = {
        overflow: body.style.overflow,
        paddingRight: body.style.paddingRight,
      };
      const scrollbarWidth = window.innerWidth - documentElement.clientWidth;
      body.style.overflow = 'hidden';
      if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;
    }
    activeModalLayers += 1;

    return () => {
      activeModalLayers -= 1;
      if (activeModalLayers === 0 && savedBodyStyles) {
        body.style.overflow = savedBodyStyles.overflow;
        body.style.paddingRight = savedBodyStyles.paddingRight;
        savedBodyStyles = undefined;
      }
    };
  }, []);

  return createPortal(<div className={className}>{children}</div>, document.body);
}
