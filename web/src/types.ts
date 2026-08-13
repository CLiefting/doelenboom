export type TenantRoleName = 'admin' | 'gebruiker';

export type UserTenantRole = {
  tenantId: number;
  tenantSlug: string;
  tenantName: string;
  role: TenantRoleName;
};

export type User = {
  id: number;
  email: string;
  isSysadmin: boolean;
  mustChangePassword: boolean;
  tenantRoles: UserTenantRole[];
};

export type UserSummary = {
  id: number;
  email: string;
  is_sysadmin: boolean;
  must_change_password: boolean;
  created_at: string;
  tenantRoles: UserTenantRole[];
};

export type TenantMember = { user_id: number; email: string; role: TenantRoleName };

export type DbStatDoelenboom = {
  id: number;
  slug: string;
  name: string;
  elementCount: number;
  edgeCount: number;
  tagCount: number;
  orgUnitCount: number;
  importCount: number;
};

export type DbStatTenant = {
  id: number;
  slug: string;
  name: string;
  wipeOnEmpty: boolean;
  sessionTimeoutMinutes: number;
  doelenbomen: DbStatDoelenboom[];
};

export type WipeCandidate = {
  tenant: { id: number; slug: string; name: string };
  doelenbomen: Array<{ id: number; slug: string; name: string }>;
};

export type TenantSummary = {
  id: number;
  slug: string;
  name: string;
  wipe_on_empty: boolean;
  session_timeout_minutes: number;
  created_at: string;
  my_role?: TenantRoleName; // alleen aanwezig als niet-sysadmin dit ophaalt
};

export type DoelenboomSummary = {
  id: number;
  slug: string;
  name: string;
  created_at: string;
  tenant_id: number;
  tenant_slug: string;
  tenant_name: string;
};

export type Element = {
  code: string;
  type: string;
  name: string;
  description: string;
  parent_text: string;
  kpi: string;
  taakveld: string;
  subtaakveld: string;
  sort_order: number;
};

export type Edge = { source: string; target: string; weight: string | null; toelichting: string };

export type ProjectStatus = {
  projectstatus: string;
  rag: string;
  toelichting: string;
  gerapporteerdOp: string | null;
  clusterPpt?: string;
};

export type Product = {
  code: string;
  name: string;
  omschrijving: string;
  pctGereed: number;
  verwachteDatum: string | null;
  werkelijkeDatum: string | null;
  opmerking: string;
};

export type Tag = { code: string; name: string; categorie: string; omschrijving: string };
export type OrgUnit = { code: string; name: string; omschrijving: string };
export type ObOrgRelation = { org: string; relatietype: string; toelichting: string; status: string };

export type TreeResponse = {
  doelenboom: { id: number; slug: string; name: string; tenant: { id: number; slug: string; name: string } };
  elements: Element[];
  edges: Edge[];
  projectStatus: Record<string, ProjectStatus>;
  products: Record<string, Product[]>;
  tags: Tag[];
  elementTags: Record<string, string[]>;
  orgUnits: OrgUnit[];
  obOrg: Record<string, ObOrgRelation[]>;
};

export type ImportSummary = {
  id: number;
  filename: string;
  uploaded_at: string;
  status: string;
  published_at: string | null;
};

export type ImportReport = {
  filename: string;
  format?: 'oud' | 'nieuw';
  sheetsFound: string[];
  sheetsMissing: string[];
  counts: Record<string, number>;
  warnings: string[];
  errors: string[];
};

export type ImportDetail = ImportSummary & {
  doelenboom_id: number;
  report_json: ImportReport;
};
