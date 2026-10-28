import PdfViewer from "../components/pdf-viewer";

export default function HomePage() {
  return (
    <main className="workspace">
      <header className="workspace-header">
        <p className="eyebrow">A little room for your documents</p>
        <h1>Adobo Acrobatics</h1>
        <p className="intro">Preview PDFs privately, right in your browser.</p>
      </header>
      <PdfViewer />
    </main>
  );
}
