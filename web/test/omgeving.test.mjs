// Regressietests voor DOEL-131: groene (ontwikkeling) of gele (acceptatie)
// driehoek linksboven op elke pagina, "[ONT]"/"[ACC]" voor de tabbladtitel,
// en niets in productie.
//
// 1. functioneel: web/src/omgeving.ts wordt rechtstreeks geladen (Node strip
//    de TypeScript-types; CI draait Node 24);
// 2. structureel: het component staat in main.tsx rond de root (dus op alle
//    pagina's), ligt bovenop alles maar vangt geen klikken, en zet de tekst
//    nooit als HTML (OWASP A03).
//
// Op de oude code falen deze tests: omgeving.ts en het component bestonden niet.
// Uitvoeren: node --test web/test/omgeving.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { driehoekVoor, tabTitel } = await import(path.join(web, 'src', 'omgeving.ts'));
const read = (rel) => readFileSync(path.join(web, rel), 'utf8');

describe('DOEL-131: driehoek per omgeving', () => {
  it('acceptatie: geel met "ACC"', () => {
    const w = driehoekVoor('acceptatie');
    assert.equal(w.label, 'ACC');
    assert.equal(w.achtergrond, '#FFC107');
    assert.equal(w.omschrijving, 'Acceptatieomgeving');
  });

  it('ontwikkeling: groen met "ONT", witte tekst', () => {
    const w = driehoekVoor('ontwikkeling');
    assert.equal(w.label, 'ONT');
    assert.equal(w.achtergrond, '#2E7D32');
    assert.equal(w.tekstkleur, '#FFFFFF');
  });

  it('productie, ontbrekend of onbekend: geen driehoek', () => {
    for (const v of ['productie', undefined, null, '', 'ACC', 'toString', '__proto__', 42, {}]) {
      assert.equal(driehoekVoor(v), null, `onverwacht een driehoek voor ${String(v)}`);
    }
  });

  it('witte tekst op groen is goed leesbaar (contrast ≥ 4,5:1)', () => {
    const lum = (hex) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    for (const o of ['ontwikkeling', 'acceptatie']) {
      const w = driehoekVoor(o);
      const [a, b] = [lum(w.achtergrond), lum(w.tekstkleur)].sort((x, y) => y - x);
      assert.ok((a + 0.05) / (b + 0.05) >= 4.5, `${o}: contrast te laag`);
    }
  });
});

describe('DOEL-131: tabbladtitel', () => {
  it('[ACC] en [ONT] vooraan, productie ongewijzigd', () => {
    assert.equal(tabTitel('Doelenboom', 'acceptatie'), '[ACC] Doelenboom');
    assert.equal(tabTitel('Doelenboom', 'ontwikkeling'), '[ONT] Doelenboom');
    assert.equal(tabTitel('Doelenboom', undefined), 'Doelenboom');
  });

  it('nooit dubbel, ook niet bij een tweede keer', () => {
    assert.equal(tabTitel(tabTitel('Doelenboom', 'acceptatie'), 'acceptatie'), '[ACC] Doelenboom');
    assert.equal(tabTitel('[ONT] Doelenboom', 'acceptatie'), '[ACC] Doelenboom');
  });
});

describe('DOEL-131: plaatsing en veiligheid van het component', () => {
  const main = read('src/main.tsx');
  const comp = read('src/components/OmgevingsDriehoek.tsx');

  it('staat in main.tsx naast de root, dus op elke pagina (ook /dbstat, /system-info, inloggen)', () => {
    assert.match(main, /import OmgevingsDriehoek from '\.\/components\/OmgevingsDriehoek'/);
    assert.match(main, /<Root \/>\s*(\{\/\*[^]*?\*\/\}\s*)?<OmgevingsDriehoek \/>/);
  });

  it('linksboven, vast, bovenop alles (ook boven het tree.html-iframe), klikken gaan erdoorheen', () => {
    for (const re of [/position: 'fixed'/, /top: 0/, /left: 0/, /zIndex: 2147483647/, /pointerEvents: 'none'/, /clipPath: 'polygon\(0 0, 100% 0, 0 100%\)'/]) {
      assert.match(comp, re);
    }
  });

  it('toegankelijk en zonder HTML-injectie (A03)', () => {
    assert.match(comp, /role="img"/);
    assert.match(comp, /aria-label=\{weergave\.omschrijving\}/);
    assert.doesNotMatch(comp, /dangerouslySetInnerHTML|innerHTML/);
  });

  it('productie: het component rendert niets', () => {
    assert.match(comp, /if \(!weergave\) return null;/);
  });
});
