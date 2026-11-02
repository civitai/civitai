/** @resolution */
uniform vec2 u_resolution;

/** @time */
uniform float u_time;

/**
 * @label Glow Color
 * @color
 * @default #E8A23C
 */
uniform vec3 u_color;

/**
 * @label Intensity
 * @range 0, 1
 * @default 0.34
 */
uniform float u_intensity;

/**
 * @label Flicker Amount
 * @range 0, 0.6
 * @default 0.22
 */
uniform float u_flicker;

/**
 * @label Flicker Speed
 * @range 0.2, 3
 * @default 1
 */
uniform float u_speed;

void main() {
  vec2 p = (gl_FragCoord.xy / u_resolution - 0.5) * 2.0;
  p.x *= u_resolution.x / max(u_resolution.y, 1.0);

  float t = u_time * u_speed;
  // Three incommensurate sines read as an irregular, slow candle wobble.
  float f = 0.5 * sin(t * 2.3) + 0.3 * sin(t * 4.1 + 1.7) + 0.2 * sin(t * 7.7 + 4.0);

  // The glow breathes in size as well as brightness, with a small warm bias toward the bottom.
  p.y += 0.06;
  float r = length(p) / (0.92 + 0.06 * f);
  float glow = pow(max(1.0 - r, 0.0), 2.2);

  float a = clamp(glow * u_intensity * (1.0 + u_flicker * f), 0.0, 1.0);
  gl_FragColor = vec4(u_color * a, a);
}
