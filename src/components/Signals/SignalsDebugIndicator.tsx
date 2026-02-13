import { useEffect, useState } from 'react';
import { useSignalContext } from './SignalsProvider';

function useSignalsDebugEnabled() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const check = () => setEnabled(localStorage.getItem('signals-debug') === 'true');
    check();
    window.addEventListener('storage', check);
    return () => window.removeEventListener('storage', check);
  }, []);
  return enabled;
}

const statusColors: Record<string, string> = {
  connected: '#22c55e',
  reconnecting: '#eab308',
  closed: '#ef4444',
};

export function SignalsDebugIndicator() {
  const enabled = useSignalsDebugEnabled();
  const { status } = useSignalContext();

  if (!enabled) return null;

  const color = statusColors[status ?? ''] ?? '#6b7280';

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 8,
        left: 8,
        zIndex: 99999,
        fontFamily: 'monospace',
        fontSize: 11,
        background: '#1a1a2e',
        color: '#e0e0e0',
        borderRadius: 6,
        border: '1px solid #333',
        padding: '4px 8px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        cursor: 'default',
        userSelect: 'none',
      }}
      title="Enable detailed output: signalsDump() / signalsStatus() / signalsVerbose()"
    >
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
          boxShadow: `0 0 4px ${color}`,
        }}
      />
      <span>signals: {status ?? 'null'}</span>
    </div>
  );
}
