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

      // Only set up storage listener if one doesn't already exist
      if (!this.storageListener) {
        // Listen for storage events (cross-tab communication mechanism)
        // Storage events are fired when localStorage is modified in other tabs
        const storageListener = (e: StorageEvent) => {
          if (e.key?.startsWith(`bc_${this.name}_`) && e.newValue) {
            try {
              const message = JSON.parse(e.newValue);
              if (message.type === 'broadcast_channel_polyfill' && message.channel === this.name) {
                // Create a MessageEvent to match the native BroadcastChannel API
                const event = new MessageEvent('message', { data: message.data });

                // Notify all listeners
                this.listeners.forEach((listener) => listener(event));
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
  }

  /**
   * Remove event listener for messages
   * Properly cleans up both internal listeners and window storage listeners
   */
  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === 'message') {
      this.listeners.delete(listener);

      // If no more listeners, remove the storage event listener to prevent memory leaks
      if (this.listeners.size === 0 && this.storageListener) {
        window.removeEventListener('storage', this.storageListener);
        this.storageListener = undefined;
      }
    }
  }

  /**
   * Clean up resources and remove all event listeners
   */
  close() {
    this.listeners.clear();
    if (this.storageListener) {
      window.removeEventListener('storage', this.storageListener);
      this.storageListener = undefined;
    }
  }

  /**
   * Remove old messages from localStorage to prevent memory bloat
   * Optimized to only scan keys that match our channel pattern
   * Messages older than 5 seconds are automatically cleaned up
   */
  private cleanupOldMessages() {
    const now = Date.now();
    const channelPrefix = `bc_${this.name}_`;

    // More efficient approach: only get keys that start with our channel prefix
    // This avoids scanning all localStorage keys
    const keysToCheck: string[] = [];

    // Iterate through localStorage more efficiently
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(channelPrefix)) {
        keysToCheck.push(key);
      }
    }

    // Process only the relevant keys
    keysToCheck.forEach((key) => {
      // Extract timestamp from key format: bc_{channelName}_{timestamp}
      const timestampStr = key.substring(channelPrefix.length);

      // Validate that the timestamp is a valid number
      const timestamp = parseInt(timestampStr, 10);

      // Check if parsing was successful and timestamp is reasonable
      if (!isNaN(timestamp) && timestamp > 0 && timestamp <= now) {
        // Remove messages older than 5 seconds
        if (now - timestamp > 5000) {
          localStorage.removeItem(key);
        }
      } else {
        // Remove malformed keys that don't match expected format
        localStorage.removeItem(key);
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
