import { SiteHeader } from "@/components/site-header";

const loadingRows = [0, 1, 2] as const;

export default function Loading() {
  return (
    <div className="site-frame loading-page">
      <SiteHeader />
      <main aria-busy="true" aria-label="Loading Aisle" className="loading-state shell">
        <div aria-hidden="true" className="loading-state__visual">
          <span className="loading-state__skeleton loading-state__back" />

          <section className="loading-state__hero">
            <div className="loading-state__hero-copy">
              <span className="loading-state__skeleton loading-state__badge" />
              <div className="loading-state__title">
                <span className="loading-state__skeleton" />
                <span className="loading-state__skeleton" />
              </div>
              <span className="loading-state__skeleton loading-state__meta" />
            </div>
            <div className="loading-state__actions">
              <span className="loading-state__skeleton" />
              <span className="loading-state__skeleton" />
            </div>
          </section>

          <section className="loading-state__content">
            <div className="loading-state__heading">
              <div>
                <span className="loading-state__skeleton loading-state__eyebrow" />
                <span className="loading-state__skeleton loading-state__section-title" />
              </div>
              <span className="loading-state__skeleton loading-state__heading-note" />
            </div>

            <div className="loading-state__toolbar">
              <span className="loading-state__skeleton loading-state__search-icon" />
              <span className="loading-state__skeleton loading-state__search-line" />
              <span className="loading-state__skeleton loading-state__search-action" />
            </div>

            <div className="loading-state__rows">
              {loadingRows.map((row) => (
                <div className="loading-state__row" key={row}>
                  <span className="loading-state__skeleton loading-state__row-index" />
                  <div>
                    <span className="loading-state__skeleton loading-state__row-title" />
                    <span className="loading-state__skeleton loading-state__row-copy" />
                  </div>
                  <span className="loading-state__skeleton loading-state__row-source" />
                </div>
              ))}
            </div>
          </section>
        </div>
        <span className="sr-only">Loading Aisle…</span>
      </main>
    </div>
  );
}
