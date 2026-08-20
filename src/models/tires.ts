/** Bounded load-sensitive friction model (spec 10.1).
 *
 * `mu(Fz) = mu_ref * [1 - k_mu * (Fz - Fz_ref) / Fz_ref]` clamped to
 * `[mu_min, mu_max]`. `lateral_mu_scale` lets the lateral axis of the
 * friction ellipse differ from the longitudinal one (`mu_y = scale * mu_x`);
 * the default 1.0 keeps the circle assumption until tire data says otherwise. */
export interface LoadSensitiveTire {
  name: string;
  mu_ref: number;
  fz_ref_n: number;
  k_mu: number;
  mu_min: number;
  mu_max: number;
  lateral_mu_scale?: number;
}

/** Longitudinal friction coefficient at a wheel load. */
export function muX(tire: LoadSensitiveTire, fzN: number): number {
  const mu = tire.mu_ref * (1.0 - (tire.k_mu * (fzN - tire.fz_ref_n)) / tire.fz_ref_n);
  return Math.min(Math.max(mu, tire.mu_min), tire.mu_max);
}

/** Lateral friction coefficient at a wheel load. */
export function muY(tire: LoadSensitiveTire, fzN: number): number {
  return muX(tire, fzN) * (tire.lateral_mu_scale ?? 1.0);
}

/** Spec 10.2: `Fx_max = mu_x(Fz) * Fz`. */
export function longitudinalCapacityN(tire: LoadSensitiveTire, fzN: number): number {
  return muX(tire, fzN) * fzN;
}
