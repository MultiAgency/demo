/** Classic legal sheet with a turned corner and signature rule. */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
      <path d="M7 2h13l6 6v22H7V2Z" fill="var(--primary)" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M20 2v6h6" fill="var(--primary-ink)" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M11 8h5M11 13h11M11 16h11M11 19h8" stroke="var(--primary-ink)" strokeWidth="1.5" strokeLinecap="round" />
      <path d="m11 25 2-3 1 3 2-2 1 1h4" stroke="var(--primary-ink)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
