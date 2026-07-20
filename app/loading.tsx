export default function Loading() {
  return (
    <main aria-busy="true" aria-label="Loading Aisle" className="loading-state shell">
      <div className="loading-state__brand" />
      <div className="loading-state__line loading-state__line--short" />
      <div className="loading-state__line" />
      <div className="loading-state__rail">
        <span />
        <span />
        <span />
      </div>
      <span className="sr-only">Loading…</span>
    </main>
  );
}
