export function LogoBadge({ ...props }: React.HTMLAttributes<SVGElement>) {
  return (
    <svg viewBox="0 0 20 23" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        d="M0,5.747L0,17.241L10,22.989L20,17.241L20,5.747L10,0L0,5.747Z"
        style={{
          fill: 'url(#_Linear1)',
          fillRule: 'nonzero',
        }}
      />
      <path
        d="M10,3.563L16.782,7.471L16.782,15.402L10,19.31L3.103,15.402L3.103,7.471L10,3.563M10,0L0,5.747L0,17.241L10,22.989L20,17.241L20,5.747C19.885,5.747 10,0 10,0Z"
        style={{
          fill: 'url(#_Linear2)',
          fillRule: 'nonzero',
        }}
      />
      <path
        d="M11.839,12.586L9.885,13.736L7.931,12.586L7.931,10.402L9.885,9.253L11.839,10.402L14.253,10.402L14.253,9.023L9.885,6.494L5.632,9.023L5.632,13.966L10,16.494L14.368,13.966L14.368,12.586L11.839,12.586Z"
        style={{
          fill: '#fff',
          fillRule: 'nonzero',
        }}
      />
      <defs>
        <linearGradient
          id="_Linear1"
          x1={0}
          y1={0}
          x2={1}
          y2={0}
          gradientUnits="userSpaceOnUse"
          gradientTransform="matrix(1.40684e-15,22.9754,-22.9754,1.40684e-15,9.94943,-0.0574713)"
        >
          <stop
            offset={0}
            style={{
              stopColor: '#081692',
              stopOpacity: 1,
            }}
          />
          <stop
            offset={1}
            style={{
              stopColor: '#1e043c',
              stopOpacity: 1,
            }}
          />
        </linearGradient>
        <linearGradient
          id="_Linear2"
          x1={0}
          y1={0}
          x2={1}
          y2={0}
          gradientUnits="userSpaceOnUse"
          gradientTransform="matrix(1.40764e-15,22.9885,-22.9885,1.40764e-15,9.94943,-0.0574713)"
        >
          <stop
            offset={0}
            style={{
              stopColor: '#1284f7',
              stopOpacity: 1,
            }}
          />
          <stop
            offset={1}
            style={{
              stopColor: '#0a20c9',
              stopOpacity: 1,
            }}
          />
        </linearGradient>
      </defs>
    </svg>
  );
}
