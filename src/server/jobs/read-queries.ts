/** Shared expressions keep SQLite's account lookup queries aligned with their indexes. */
export const REPRESENTATIVE_ACCOUNT_SQL = "CASE WHEN json_valid(terms) THEN json_extract(terms, '$.representative.near_account') END";
export const BUILDER_ACCOUNT_SQL = "CASE WHEN json_valid(terms) THEN json_extract(terms, '$.contractor.near_account') END";
