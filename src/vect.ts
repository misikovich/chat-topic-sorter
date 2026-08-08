export function vec_lerp(vec_a: number[], vec_b: number[], weight_b: number): number[] {
  if (vec_a.length !== vec_b.length) {
    throw new Error(`Vector length mismatch: ${vec_a.length} !== ${vec_b.length}`);
  }
  return vec_a.map((v, i) => v * (1 - weight_b) + vec_b[i]! * weight_b);
}

export function vec_normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    throw new Error("Attempted to normalize a zero vector");
  }
  return vec.map((v) => v / norm);
}

export function vec_affinity(vec_a: number[], vec_b: number[]): number {
  if (vec_a.length !== vec_b.length) {
    throw new Error(`Vector length mismatch: ${vec_a.length} !== ${vec_b.length}`);
  }
  const norm_a = vec_normalize(vec_a);
  const norm_b = vec_normalize(vec_b);
  return norm_a.reduce((sum, value, index) => sum + value * norm_b[index]!, 0);
}
