export function MarketplaceLoading({ label }: { label: string }) {
  return (
    <main aria-busy="true" aria-label={label} className="market-route-loading shell">
      <div className="market-route-loading__rail" />
      <div className="market-route-loading__content">
        <div className="market-route-loading__hero" />
        <div className="market-route-loading__grid">
          <div className="market-route-loading__card" />
          <div className="market-route-loading__card" />
        </div>
      </div>
      <span className="sr-only">Loading marketplace content…</span>
    </main>
  );
}
