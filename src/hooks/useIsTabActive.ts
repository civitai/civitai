import { useState, useEffect } from 'react';

interface BroadcastMessage {
  type: string;
}

/**
 * BroadcastChannel polyfill using localStorage for cross-tab communication
 * Provides fallback support for browsers that don't support the native BroadcastChannel API
 *
 * This polyfill was developed using AI assistance to ensure cross-browser compatibility
 */
class BroadcastChannelPolyfill {
  private name: string;
  private listeners: Set<(event: MessageEvent) => void> = new Set();
  private storageListener?: (e: StorageEvent) => void;

  constructor(name: string) {
    this.name = name;
  }

  /**
   * Send a message to all tabs listening on the same channel
   * Uses localStorage as the transport mechanism
   */
  postMessage(data: BroadcastMessage) {
    const message = {
      type: 'broadcast_channel_polyfill',
      channel: this.name,
      data,
      timestamp: Date.now(),
    };

    // Use localStorage to communicate between tabs - triggers storage events in other tabs
    localStorage.setItem(`bc_${this.name}_${message.timestamp}`, JSON.stringify(message));

    // Clean up old messages to prevent localStorage bloat
    this.cleanupOldMessages();
  }

  /**
   * Add event listener for incoming messages
   * Uses storage events to detect when other tabs send messages
   */
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === 'message') {
      this.listeners.add(listener);

      // Listen for storage events (cross-tab communication mechanism)
      // Storage events are fired when localStorage is modified in other tabs
      const storageListener = (e: StorageEvent) => {
        if (e.key?.startsWith(`bc_${this.name}_`) && e.newValue) {
          try {
            const message = JSON.parse(e.newValue);
            if (message.type === 'broadcast_channel_polyfill' && message.channel === this.name) {
              // Create a MessageEvent to match the native BroadcastChannel API
              const event = new MessageEvent('message', { data: message.data });
              listener(event);
            }
          } catch (error) {
            // Ignore parsing errors from corrupted localStorage data
          }
        }
      };

      window.addEventListener('storage', storageListener);
      this.storageListener = storageListener;
    }
  }

  /**
   * Remove event listener for messages
   */
  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === 'message') {
      this.listeners.delete(listener);
    }
  }

  /**
   * Clean up resources and remove all event listeners
   */
  close() {
    this.listeners.clear();
    if (this.storageListener) {
      window.removeEventListener('storage', this.storageListener);
    }
  }

  /**
   * Remove old messages from localStorage to prevent memory bloat
   * Messages older than 5 seconds are automatically cleaned up
   */
  private cleanupOldMessages() {
    const now = Date.now();
    const keys = Object.keys(localStorage);

    keys.forEach((key) => {
      if (key.startsWith(`bc_${this.name}_`)) {
        const timestamp = parseInt(key.split('_').pop() || '0');
        // Remove messages older than 5 seconds
        if (now - timestamp > 5000) {
          localStorage.removeItem(key);
        }
      }
    });
  }
}

/**
 * Hook to detect if another tab of the same application is open
 * Uses BroadcastChannel API with localStorage polyfill for cross-browser support
 *
 * @returns boolean - true if another tab is detected, false otherwise
 */
export const useIsTabActive = () => {
  const [anotherTabOpen, setAnotherTabOpen] = useState(false);

  useEffect(() => {
    // Use native BroadcastChannel if available, otherwise use polyfill for Safari/older browsers
    const ChannelConstructor =
      typeof BroadcastChannel !== 'undefined' ? BroadcastChannel : BroadcastChannelPolyfill;

    const channel = new ChannelConstructor('app_presence_channel');
    let hasReceivedPong = false;

    const handleMessage = (event: MessageEvent) => {
      const { type } = event.data;
      if (type === 'PING') {
        // Another tab is asking if we're here - respond with PONG
        channel.postMessage({ type: 'PONG' });
      } else if (type === 'PONG') {
        // Another tab responded to our PING - mark that another tab is open
        hasReceivedPong = true;
        setAnotherTabOpen(true);
      }
    };

    channel.addEventListener('message', handleMessage);

    // Send out a ping to detect other tabs
    channel.postMessage({ type: 'PING' });

    // If no response in 1 second, assume no other tab is open
    const timeout = setTimeout(() => {
      if (!hasReceivedPong) setAnotherTabOpen(false);
    }, 1000);

    return () => {
      clearTimeout(timeout);
      channel.removeEventListener('message', handleMessage);
      channel.close();
    };
  }, []);

  return anotherTabOpen;
};
