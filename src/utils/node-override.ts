export function applyNodeOverrides() {
  if (typeof window === 'undefined' || window.__nodeOverridesApplied) return;

  const originalRemoveChild = Node.prototype.removeChild;

  Node.prototype.removeChild = function <T extends Node>(child: T): T {
    try {
      return originalRemoveChild.call(this, child) as T;
    } catch (error: any) {
      if (error.name === 'NotFoundError') {
        // Prevents crashes by ignoring the error
        return child;
      }
      throw error;
    }
  };

  const originalInsertBefore = Node.prototype.insertBefore;

  Node.prototype.insertBefore = function <T extends Node>(
    newNode: T,
    referenceNode: Node | null
  ): T {
    try {
      return originalInsertBefore.call(this, newNode, referenceNode) as T;
    } catch (error: any) {
      if (error.name === 'NotFoundError') {
        // If insertion fails, append the element instead
        return this.appendChild(newNode);
      }
      throw error;
    }
  };

  window.__nodeOverridesApplied = true;
}

declare global {
  interface Window {
    __nodeOverridesApplied: boolean;
  }
}
