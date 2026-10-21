# Physics fixtures

Three textbook problems with known answers, used by the physics plug-in's
tests as task definitions:

| File | Problem | Reference answer |
|---|---|---|
| `pendulum-period.json` | Simple pendulum, L = 1 m, amplitude 0.2 rad | T = 4 sqrt(L/g) K(sin²(θ₀/2)) = 2.011093 s; small-angle limit 2π sqrt(L/g) |
| `rc-charging.json` | RC charging, 10 kΩ, 100 µF, 5 V, t = 1 s | V = V₀(1 − e^(−t/RC)) = 3.160603 V |
| `projectile-range.json` | Baseball with quadratic drag, 40 m/s at 35° | 84.659 m (drag-free limit 153.26 m) |

Each file holds the problem statement (`statement`, `given`, `find`), the
reference answer (`answer`, never ingested into the graph), a derivation in
the JSON form `physics.derive` asks a model for (`derivation`), and a
computation with an independent cross-check in the form `physics.compute`
takes (`computation`).

Source: written for Scope Studio from standard results. The pendulum and RC
answers are the closed forms evaluated directly; the projectile reference was
computed independently with SciPy's `solve_ivp` (rtol and atol 1e-12, launch
at the origin, terminal event at y = 0).

Licence: CC0 1.0 (public domain dedication).
