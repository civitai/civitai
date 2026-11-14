/** @resolution */
uniform vec2 u_resolution;

/** @time */
uniform float u_time;

/**
 * @label Highlight Color
 * @color
 * @default #F3D98A
 */
uniform vec3 u_color;

/**
 * @label Intensity
 * @range 0, 1
 * @default 0.16
 */
uniform float u_intensity;

/**
 * @label Band Width
 * @range 0.05, 0.5
 * @default 0.14
 */
uniform float u_width;

/**
 * @label Period (seconds)
 * @range 1, 8
 * @default 2.5
 */
uniform float u_period;

/**
 * @label Freeze Phase (-1 = animate)
 * @range -1, 1
 * @default -1
 */
uniform float u_phase;

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);

  // Diagonal coordinate, 0 at one corner and 1 at the opposite corner.
  float d = (uv.x * aspect + (1.0 - uv.y)) / (aspect + 1.0);

  // One sweep per period: the band travels during the first 45% and rests for the remainder.
  float ph = u_phase < -0.5 ? fract(u_time / u_period) : clamp(u_phase, 0.0, 1.0);
  float s = clamp(ph / 0.45, 0.0, 1.0);
  float center = mix(-u_width, 1.0 + u_width, s);

  float band = smoothstep(u_width, 0.0, abs(d - center));
  float a = band * u_intensity;

  gl_FragColor = vec4(u_color * a, a);
}
