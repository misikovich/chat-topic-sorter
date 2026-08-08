import assert from "node:assert/strict";
import { test } from "node:test";
import { vec_affinity, vec_lerp, vec_normalize } from "./vect.ts";

test("vec_lerp mixes vectors by weight without mutating inputs", () => {
  const a = [1, 2, 3];
  const b = [5, 6, 7];
  assert.deepEqual(vec_lerp(a, b, 0.25), [2, 3, 4]);
  assert.deepEqual(vec_lerp(a, b, 0), [1, 2, 3]);
  assert.deepEqual(vec_lerp(a, b, 1), [5, 6, 7]);
  assert.deepEqual(a, [1, 2, 3]);
  assert.deepEqual(b, [5, 6, 7]);
});

test("vec_lerp rejects length mismatch", () => {
  assert.throws(() => vec_lerp([1], [1, 2], 0.5), /Vector length mismatch: 1 !== 2/);
  assert.throws(() => vec_lerp([], [1], 0.5), /Vector length mismatch: 0 !== 1/);
});

test("vec_normalize scales a vector to unit length", () => {
  const result = vec_normalize([3, 4]);
  assert.deepEqual(result, [0.6, 0.8]);
  const norm = Math.sqrt(result.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 1e-12);
});

test("vec_normalize keeps unit vectors unchanged", () => {
  assert.deepEqual(vec_normalize([1, 0, 0]), [1, 0, 0]);
  assert.deepEqual(vec_normalize([Math.SQRT1_2, Math.SQRT1_2]), [Math.SQRT1_2, Math.SQRT1_2]);
});

test("vec_normalize rejects zero and empty vectors", () => {
  assert.throws(() => vec_normalize([0, 0, 0]), /Attempted to normalize a zero vector/);
  assert.throws(() => vec_normalize([]), /Attempted to normalize a zero vector/);
});

test("topic centroid flow: EMA update stays a unit vector leaning toward the anchor", () => {
  let centroid = [1, 0];
  centroid = vec_normalize(vec_lerp(centroid, [0, 1], 0.1));
  centroid = vec_normalize(vec_lerp(centroid, [0, 1], 0.1));
  const norm = Math.hypot(centroid[0]!, centroid[1]!);
  assert.ok(Math.abs(norm - 1) < 1e-12);
  assert.ok(centroid[0]! > centroid[1]!);
});

test("vec_affinity is 1 for identical, 0 for orthogonal, -1 for opposite vectors", () => {
  assert.ok(Math.abs(vec_affinity([1, 0], [1, 0]) - 1) < 1e-12);
  assert.ok(Math.abs(vec_affinity([1, 0], [0, 1])) < 1e-12);
  assert.ok(Math.abs(vec_affinity([1, 0], [-1, 0]) + 1) < 1e-12);
});

test("vec_affinity is scale-invariant on non-unit vectors", () => {
  assert.ok(Math.abs(vec_affinity([3, 4], [6, 8]) - 1) < 1e-12);
  assert.ok(Math.abs(vec_affinity([3, 4], [4, -3])) < 1e-12);
  assert.ok(Math.abs(vec_affinity([1, 0], [1, 1]) - Math.SQRT1_2) < 1e-12);
});

test("vec_affinity rejects length mismatch and zero vectors", () => {
  assert.throws(() => vec_affinity([1], [1, 2]), /Vector length mismatch: 1 !== 2/);
  assert.throws(() => vec_affinity([0, 0], [1, 2]), /Attempted to normalize a zero vector/);
});
