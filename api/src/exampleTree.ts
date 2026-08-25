import { PoolClient } from 'pg';

// Zaait één voorbeeldelement per kolom (in kolomvolgorde met elkaar
// verbonden) in een net aangemaakte, lege doelenboom — zonder dit zou een
// gebruiker na het aanmaken van een nieuwe doelenboom een volledig leeg
// scherm zien (geen kolommen zichtbaar, want die tonen alleen elementen die
// er al zijn). Met dit voorbeeld ziet iemand meteen hoe een compleet pad
// door de boom eruitziet.
//
// Elementnamen: "Voorbeeld van <typeName>" (bv. "Voorbeeld van Project"),
// codes V1, V2, ... in kolomvolgorde — zelfde generieke-prefix-conventie als
// de automatische T1/O1-codes bij tags/organisatieonderdelen
// (routes/tags.ts / orgUnits.ts). Relaties volgen de kolomvolgorde (kolom i
// → kolom i+1, dus bv. Project → Capability → ... → Missie), met de
// relationLabelToNext van de bronkolom als toelichting op de relatie (zelfde
// tekst die de boomweergave zelf als kolomrelatie-label toont).
//
// Alleen bedoeld voor het aanmaken van een NIEUWE, lege doelenboom (zie
// routes/doelenbomen.ts POST /tenants/:tenantId/doelenbomen) — niet voor
// dupliceren (die kopieert al de echte inhoud van de bron) en niet voor
// bestaande doelenbomen. Moet binnen dezelfde transactie als het aanmaken
// van de doelenboom + kolomconfiguratie aangeroepen worden (de kolommen
// moeten al bestaan, zie createDoelenboomConfigFromTenantDefault).
export async function seedExampleTree(client: PoolClient, doelenboomId: number): Promise<void> {
  const columnsResult = await client.query(
    `select position, type_name as "typeName", relation_label_to_next as "relationLabelToNext"
     from columns
     where column_config_id = (select id from column_configs where scope = 'doelenboom' and doelenboom_id = $1)
     order by position`,
    [doelenboomId]
  );
  const columns = columnsResult.rows as { position: number; typeName: string; relationLabelToNext: string | null }[];
  if (columns.length === 0) return;

  const codes: string[] = [];
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const code = `V${i + 1}`;
    codes.push(code);
    await client.query(
      `insert into elements (doelenboom_id, code, type, name, sort_order)
       values ($1, $2, $3, $4, $5)`,
      [doelenboomId, code, col.typeName, `Voorbeeld van ${col.typeName}`, i + 1]
    );
  }

  for (let i = 0; i < columns.length - 1; i++) {
    const sourceId = await elementIdByCode(client, doelenboomId, codes[i]);
    const targetId = await elementIdByCode(client, doelenboomId, codes[i + 1]);
    if (!sourceId || !targetId) continue;
    await client.query(
      `insert into edges (doelenboom_id, source_element_id, target_element_id, weight, toelichting)
       values ($1, $2, $3, 'primair', $4)`,
      [doelenboomId, sourceId, targetId, columns[i].relationLabelToNext ?? '']
    );
  }
}

async function elementIdByCode(client: PoolClient, doelenboomId: number, code: string): Promise<number | null> {
  const r = await client.query('select id from elements where doelenboom_id = $1 and code = $2', [doelenboomId, code]);
  return r.rows[0]?.id ?? null;
}
