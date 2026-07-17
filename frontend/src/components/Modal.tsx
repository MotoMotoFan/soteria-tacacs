import { X } from 'lucide-react';
import { ReactNode } from 'react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  maxWidth?: string;
}

export default function Modal({ open, onClose, title, children, maxWidth = 'max-w-lg' }: ModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        className={`relative ${maxWidth} w-full mx-4 rounded-xl shadow-2xl flex flex-col max-h-[90vh]`}
        style={{ backgroundColor: 'var(--s-surface)', border: '1px solid var(--s-border)' }}
      >
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 shrink-0" style={{ borderBottom: '1px solid var(--s-border)' }}>
          <h3 className="text-lg font-semibold heading truncate pr-2">{title}</h3>
          <button onClick={onClose} className="transition-colors shrink-0" style={{ color: 'var(--s-muted)' }} aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-4 sm:px-6 py-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
