interface BuzzBoltSvgProps {
  size?: number;
  color?: string;
  fill?: string;
  className?: string;
  gradient?: string;
}

export function BuzzBoltSvg({ size = 16, color, fill, className, gradient }: BuzzBoltSvgProps) {
  const gradientId = `buzz-bolt-gradient-${Math.random().toString(36).substr(2, 9)}`;

  // Parse CSS gradient into SVG stops and direction
  const parseGradientStops = (gradientStr: string) => {
    if (!gradientStr.includes('linear-gradient')) {
      return { stops: [{ color: gradientStr, offset: '0%' }], direction: 'to right' };
    }

    try {
      const match = gradientStr.match(/linear-gradient\([^)]+\)/)?.[0];
      if (!match) return { stops: [{ color: gradientStr, offset: '0%' }], direction: 'to right' };

      const content = match.replace('linear-gradient(', '').replace(')', '');
      const parts = content.split(',');

      // Extract direction (first part)
      const direction = parts[0]?.trim() || 'to right';
      const colorStops = parts.slice(1); // Remove direction

      const stops = colorStops.map((stop, index) => {
        const trimmed = stop.trim();
        const spaceIndex = trimmed.lastIndexOf(' ');
        const hasPercentage = trimmed.includes('%');

        if (hasPercentage && spaceIndex > 0) {
          const color = trimmed.substring(0, spaceIndex);
          const offset = trimmed.substring(spaceIndex + 1);
          return { color, offset };
        }

        // Distribute evenly if no percentage
        const offset = `${(index / Math.max(colorStops.length - 1, 1)) * 100}%`;
        return { color: trimmed, offset };
      });

      return { stops, direction };
    } catch {
      return { stops: [{ color: gradientStr, offset: '0%' }], direction: 'to right' };
    }
  };

  // Convert CSS gradient direction to SVG coordinates
  const getGradientCoordinates = (direction: string) => {
    const dir = direction.toLowerCase().trim();

    if (dir.includes('to right') || dir.includes('90deg')) {
      return { x1: '0%', y1: '0%', x2: '100%', y2: '0%' };
    }
    if (dir.includes('to left') || dir.includes('270deg')) {
      return { x1: '100%', y1: '0%', x2: '0%', y2: '0%' };
    }
    if (dir.includes('to bottom') || dir.includes('180deg')) {
      return { x1: '0%', y1: '0%', x2: '0%', y2: '100%' };
    }
    if (dir.includes('to top') || dir.includes('0deg')) {
      return { x1: '0%', y1: '100%', x2: '0%', y2: '0%' };
    }

    // Default to right
    return { x1: '0%', y1: '0%', x2: '100%', y2: '0%' };
  };

  const gradientData = gradient
    ? parseGradientStops(gradient)
    : { stops: [], direction: 'to right' };
  const coordinates = getGradientCoordinates(gradientData.direction);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      stroke={gradient ? `url(#${gradientId})` : color || 'currentColor'}
      fill={gradient ? `url(#${gradientId})` : fill || 'none'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`tabler-icon tabler-icon-bolt ${className || ''}`.trim()}
    >
      {gradient && (
        <defs>
          <linearGradient
            id={gradientId}
            x1={coordinates.x1}
            y1={coordinates.y1}
            x2={coordinates.x2}
            y2={coordinates.y2}
          >
            {gradientData.stops.map((stop, index) => (
              <stop key={index} offset={stop.offset} stopColor={stop.color} />
            ))}
          </linearGradient>
        </defs>
      )}
      <path d="M13 3l0 7l6 0l-8 11l0 -7l-6 0l8 -11"></path>
    </svg>
  );
}
