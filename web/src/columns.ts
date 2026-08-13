// Golden Thread kolomvolgorde, zoals gedocumenteerd in doelenboom_update_instructie.md.
export const COLUMN_ORDER = [
  'Project',
  'Capability',
  'Operationele benefit',
  'Sub-benefit',
  'Programmabaat',
  'Strategische benefit',
  'Strategisch doel',
  'Missie',
] as const;

export const COLUMN_COLORS: Record<string, string> = {
  Project: '#3E6FA6',
  Capability: '#6B4C8A',
  'Operationele benefit': '#C05A2C',
  'Sub-benefit': '#B8862E',
  Programmabaat: '#2E7D5B',
  'Strategische benefit': '#8FAADC',
  'Strategisch doel': '#2F5597',
  Missie: '#203864',
};

export const RAG_COLORS: Record<string, string> = {
  Rood: '#DC3545',
  Oranje: '#FD7E14',
  Groen: '#28A745',
};

export const STATUS_COLORS: Record<string, string> = {
  Backlog: '#9AA5B1',
  Actief: '#2F5597',
  'On-hold': '#D9822B',
  Gereed: '#2E7D5B',
  Vervallen: '#6c6f76',
};
