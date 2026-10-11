import type { APIRoute } from 'astro';
import { copyrightNotes, findAuthor, getAuthorIndex, getPublishers, getTitlesByPublisher, titleDate, type Title } from '../../../../lib/catalogue';
import { chunkCount, chunkOf } from '../../../../lib/shard';
import { getTitlePlaces } from '../../../../lib/globe-places';

/** One of a publisher's title data files: the full records of the titles hashed to it. */
export async function getStaticPaths() {
  const byPublisher = await getTitlesByPublisher();
  return (await getPublishers()).flatMap((p) => {
    const titles = byPublisher.get(p.id) ?? [];
    const chunks = chunkCount(titles.length);
    return Array.from({ length: chunks }, (_, chunk) => ({
      params: { publisher: p.id, chunk: String(chunk) },
      props: { titles: titles.filter((t) => chunkOf(t.id, chunks) === chunk) },
    }));
  });
}

export const GET: APIRoute = async ({ props }) => {
  const authorIndex = await getAuthorIndex();
  const places = await getTitlePlaces();
  const credit = (name: string) => {
    const author = findAuthor(authorIndex, name);
    return author ? { name, href: `/authors/${author.id}` } : { name };
  };
  const records = (props.titles as Title[]).map((t) => ({
    id: t.id,
    title: t.title,
    subtitle: t.subtitle,
    original_title: t.original_title,
    authors: t.authors.map(credit),
    editors: t.editors,
    translators: t.translators,
    date: titleDate(t),
    year: t.year,
    date_note: t.date_note,
    // The globe pins the title is listed under (see getTitlePlaces); used by the data download.
    places: places.get(t.href) ?? [],
    edition: t.edition,
    series: t.series,
    language: t.language,
    pages: t.pages,
    isbn: t.isbn,
    notes: t.notes,
    links: t.links,
    sources: t.sources,
    verified: t.verified,
    // Death years only for authors with a file; anyone unknown leaves the country terms unstated.
    copyright: copyrightNotes(t, t.authors.map((n) => findAuthor(authorIndex, n)?.data.died)),
  }));
  return new Response(JSON.stringify(records), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
};
