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
      className={`rounded-lg border border-gray-2 bg-gray-1 p-3 dark:border-dark-5 dark:bg-dark-6 ${className}`}
    >
      {children}
    </div>
  );
}
