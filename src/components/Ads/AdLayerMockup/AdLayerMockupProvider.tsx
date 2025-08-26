import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { AdLayerMockup } from './AdLayerMockup';

/**
 * Provider component that controls when the AdLayerMockup is shown
 * Enable with:
 * - ?adLayerMockup=true query param on any page
 * - Visiting /demo/ad-layer page
 * - localStorage flag for persistence
 */
export const AdLayerMockupProvider: React.FC = () => {
  const router = useRouter();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    // Check multiple conditions for enabling the ad layer
    const checkEnabled = () => {
      // Check query param
      const queryEnabled = router.query.adLayerMockup === 'true';
      
      // Check if on demo page
      const onDemoPage = router.pathname === '/demo/ad-layer';
      
      // Check localStorage for persistent setting
      const storageEnabled = typeof window !== 'undefined' && 
        localStorage.getItem('adLayerMockupEnabled') === 'true';
      
      return queryEnabled || onDemoPage || storageEnabled;
    };

    setEnabled(checkEnabled());
  }, [router.query, router.pathname]);

  // Handle enabling/disabling via keyboard shortcut (Ctrl/Cmd + Shift + L)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'L') {
        e.preventDefault();
        const newEnabled = !enabled;
        setEnabled(newEnabled);
        
        // Save to localStorage for persistence
        if (typeof window !== 'undefined') {
          if (newEnabled) {
            localStorage.setItem('adLayerMockupEnabled', 'true');
          } else {
            localStorage.removeItem('adLayerMockupEnabled');
          }
        }
        
        // Show notification
        const message = newEnabled 
          ? 'Ad Layer Mockup Enabled - Press Ctrl/Cmd+E to edit' 
          : 'Ad Layer Mockup Disabled';
        console.log(`%c${message}`, 'color: #3b82f6; font-weight: bold; font-size: 14px;');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled]);

  return <AdLayerMockup enabled={enabled} />;
};

export default AdLayerMockupProvider;