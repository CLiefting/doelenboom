import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertJwtSecretIsSafe } from '../src/auth.js';

// Losse unit-tests (geen server/db nodig) voor de CISO-fail-fast-check: een
// productie-opstart met een publiek bekend JWT-geheim mag nooit stilzwijgend
// doorgaan. Zuivere functie (secret/nodeEnv als parameters), dus rechtstreeks
// te testen zonder process.env te hoeven muteren of een subprocess te starten.
describe('assertJwtSecretIsSafe (CISO: geen dev-default JWT_SECRET in productie)', () => {
  it('gooit bij een bekende dev-default én NODE_ENV=production', () => {
    assert.throws(() => assertJwtSecretIsSafe('dev-secret-change-me', 'production'));
    assert.throws(() => assertJwtSecretIsSafe('dev-secret-verander-mij', 'production'));
  });

  it('gooit NIET bij een dev-default zonder NODE_ENV=production (lokale dev)', () => {
    assert.doesNotThrow(() => assertJwtSecretIsSafe('dev-secret-change-me', undefined));
    assert.doesNotThrow(() => assertJwtSecretIsSafe('dev-secret-change-me', 'development'));
    assert.doesNotThrow(() => assertJwtSecretIsSafe('dev-secret-change-me', 'test'));
  });

  it('gooit nooit bij een eigen, niet-default geheim — ook niet in productie', () => {
    assert.doesNotThrow(() => assertJwtSecretIsSafe('een-echt-willekeurig-productiegeheim-xyz', 'production'));
  });
});
