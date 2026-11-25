import { useState } from 'react';
import { Zap } from 'lucide-react';

interface PuvvnlLogoProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZE_CLASSES: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'h-9 w-9',
  md: 'h-12 w-12',
  lg: 'h-20 w-20',
};

export function PuvvnlLogo({ size = 'sm', className = '' }: PuvvnlLogoProps) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className={`${SIZE_CLASSES[size]} ${className} rounded-full bg-blue-900 text-amber-400 flex items-center justify-center shrink-0 border border-blue-800`}
        aria-label="PuVVNL लोगो"
      >
        <Zap className={size === 'lg' ? 'h-9 w-9' : size === 'md' ? 'h-6 w-6' : 'h-4 w-4'} />
      </div>
    );
  }

  return (
    <img
      src="/src/assets/images/puvvnl_logo_1795610868581.jpg"
      alt="पूर्वांचल विद्युत वितरण निगम लिमिटेड (PuVVNL) लोगो"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`${SIZE_CLASSES[size]} ${className} rounded-full object-contain bg-white shrink-0`}
    />
  );
}
