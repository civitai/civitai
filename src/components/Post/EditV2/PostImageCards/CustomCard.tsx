import React from 'react';

export function CustomCard({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`p-3 bg-gray-1 dark:bg-dark-6 rounded-lg border border-gray-2 dark:border-dark-5 ${className}`}
    >
      {children}
    </div>
  );
}
