import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical } from 'lucide-react';

export interface RowMenuItem {
  label: string;
  icon: React.ElementType;
  onClick: () => void;
  danger?: boolean;
}

/**
 * Three-dots row action menu. Renders the dropdown via createPortal with
 * position: fixed computed from the trigger's rect - absolute positioning
 * inside a table cell gets clipped by the card's overflow-hidden (same
 * pitfall as the Logs column filter dropdowns).
 */
export default function RowMenu({ items }: { items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const MENU_WIDTH = 176; // w-44

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        triggerRef.current && !triggerRef.current.contains(e.target as Node) &&
        menuRef.current && !menuRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const close = () => setOpen(false);
    document.addEventListener('mousedown', handler);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', handler);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const toggle = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
      // Flip above the trigger when there is no room below.
      const estimatedHeight = items.length * 36 + 8;
      const top = rect.bottom + estimatedHeight > window.innerHeight - 8
        ? rect.top - estimatedHeight - 4
        : rect.bottom + 4;
      setPos({ top, left });
    }
    setOpen(!open);
  };

  return (
    <>
      <button ref={triggerRef} onClick={toggle} className="p-1 transition-colors" style={{ color: 'var(--s-muted)' }}>
        <MoreVertical className="w-4 h-4" />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="fixed z-50 w-44 rounded-lg shadow-2xl py-1"
          style={{ backgroundColor: 'var(--s-surface)', border: '1px solid var(--s-border)', top: pos.top, left: pos.left }}
        >
          {items.map(item => (
            <button
              key={item.label}
              onClick={() => { setOpen(false); item.onClick(); }}
              className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2 ${item.danger ? 'text-red-400 hover:bg-red-500/10' : ''}`}
              style={item.danger ? undefined : { color: 'var(--s-text)' }}
              onMouseEnter={e => { if (!item.danger) e.currentTarget.style.backgroundColor = 'var(--s-hover)'; }}
              onMouseLeave={e => { if (!item.danger) e.currentTarget.style.backgroundColor = 'transparent'; }}
            >
              <item.icon className="w-3.5 h-3.5" /> {item.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}
