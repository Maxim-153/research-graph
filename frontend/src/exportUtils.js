export const EXPORT_FORMATS = [
  { id: 'gost_2018', label: 'ГОСТ Р 7.0.100-2018', downloadTypes: ['txt', 'rtf', 'md'] },
  { id: 'gost', label: 'ГОСТ 7.0.5-2008', downloadTypes: ['txt', 'rtf', 'md'] },
  { id: 'bibtex', label: 'BibTeX', downloadTypes: ['bib', 'txt'] },
  { id: 'markdown', label: 'Markdown', downloadTypes: ['md', 'txt'] },
  { id: 'json', label: 'JSON', downloadTypes: ['json', 'txt'] },
];

export const DOWNLOAD_TYPES = {
  txt: { label: 'TXT', extension: 'txt', mime: 'text/plain;charset=utf-8' },
  rtf: { label: 'RTF для Word', extension: 'rtf', mime: 'application/rtf' },
  md: { label: 'Markdown', extension: 'md', mime: 'text/markdown;charset=utf-8' },
  bib: { label: 'BibTeX', extension: 'bib', mime: 'application/x-bibtex;charset=utf-8' },
  json: { label: 'JSON', extension: 'json', mime: 'application/json;charset=utf-8' },
};

const getToday = () => new Intl.DateTimeFormat('ru-RU').format(new Date());

const normalizeText = (value) => String(value ?? '')
  .replace(/\s+/g, ' ')
  .trim();

const stripTrailingPeriod = (value = '') => normalizeText(value).replace(/\.+$/g, '');

const escapeBibTeX = (value = '') => String(value).replace(/[{}]/g, '');

const normalizeAuthors = (authors = []) => authors
  .map((author) => normalizeText(author?.name))
  .filter(Boolean);

const parseAuthorName = (name = '') => {
  const cleanName = normalizeText(name).replace(/\.+$/g, '');
  if (!cleanName) return { family: '', givenParts: [] };

  if (cleanName.includes(',')) {
    const [family, rest = ''] = cleanName.split(',', 2);
    return {
      family: normalizeText(family),
      givenParts: normalizeText(rest).split(/\s+/).filter(Boolean),
    };
  }

  const parts = cleanName.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { family: parts[0], givenParts: [] };

  return {
    family: parts[parts.length - 1],
    givenParts: parts.slice(0, -1),
  };
};

const toInitials = (parts = []) => parts
  .map((part) => part.replace(/[^\p{L}-]/gu, ''))
  .filter(Boolean)
  .map((part) => `${part[0].toUpperCase()}.`)
  .join(' ');

const formatSurnameInitials = (name, comma = false) => {
  const { family, givenParts } = parseAuthorName(name);
  const initials = toInitials(givenParts);
  if (!family) return '';
  if (!initials) return family;
  return comma ? `${family}, ${initials}` : `${family} ${initials}`;
};

const formatInitialsSurname = (name) => {
  const { family, givenParts } = parseAuthorName(name);
  const initials = toInitials(givenParts);
  if (!family) return '';
  return initials ? `${initials} ${family}` : family;
};

const cleanDoi = (doi = '') => normalizeText(doi)
  .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
  .replace(/^doi:\s*/i, '');

const isOpenAlexUrl = (url = '') => /^https?:\/\/openalex\.org\//i.test(url);

const getPaperUrl = (node) => {
  const landingPageUrl = node.data?.landing_page_url
    || node.data?.primary_location?.landing_page_url
    || node.data?.host_venue?.url;
  const url = node.data?.url;
  if (landingPageUrl) return landingPageUrl;
  if (url && !isOpenAlexUrl(url)) return url;
  return '';
};

const getPaperData = (node) => {
  const data = node.data || {};
  const journal = normalizeText(
    data.primary_location?.source?.display_name
      || data.source
      || data.venue,
  );
  const volume = normalizeText(data.volume);
  const issue = normalizeText(data.issue);
  const firstPage = normalizeText(data.first_page);
  const lastPage = normalizeText(data.last_page);
  const pages = firstPage && lastPage ? `${firstPage}-${lastPage}` : firstPage || lastPage;

  return {
    id: node.id,
    title: normalizeText(data.label || data.title) || 'Без названия',
    authors: normalizeAuthors(data.authors),
    year: data.year || data.publication_year || '',
    journal,
    source: journal,
    volume,
    issue,
    firstPage,
    lastPage,
    pages,
    doi: cleanDoi(data.doi),
    url: getPaperUrl(node),
    citationCount: data.citation_count || 0,
    abstract: data.abstract || '',
  };
};

export const getPaperNodes = (nodes = []) => nodes.filter((node) => node.data?.type === 'paper');

export const getConnectedPaperNodes = (selectedNode, nodes = [], edges = []) => {
  if (!selectedNode || selectedNode.data?.type !== 'paper') return [];

  const nodeIds = new Set([selectedNode.id]);
  edges.forEach((edge) => {
    if (edge.source === selectedNode.id) nodeIds.add(edge.target);
    if (edge.target === selectedNode.id) nodeIds.add(edge.source);
  });

  const selectedFirst = [];
  const connected = [];

  nodes.forEach((node) => {
    if (!nodeIds.has(node.id) || node.data?.type !== 'paper') return;
    if (node.id === selectedNode.id) selectedFirst.push(node);
    else connected.push(node);
  });

  connected.sort((a, b) => {
    const yearDiff = Number(b.data?.year || 0) - Number(a.data?.year || 0);
    if (yearDiff !== 0) return yearDiff;
    return String(a.data?.label || '').localeCompare(String(b.data?.label || ''));
  });

  return [...selectedFirst, ...connected];
};

const formatPages = (paper) => {
  if (paper.firstPage && paper.lastPage && paper.firstPage !== paper.lastPage) {
    return `${paper.firstPage}–${paper.lastPage}`;
  }

  return paper.firstPage || paper.lastPage || '';
};

const formatArticleTitle = (title) => stripTrailingPeriod(title).replace(/\s*:\s*/g, ' : ');

const formatVolumeIssue = (volume, issue) => {
  if (volume && issue) return `Т. ${volume}, № ${issue}`;
  if (volume) return `Т. ${volume}`;
  if (issue) return `№ ${issue}`;
  return '';
};

const formatGostAuthors2008 = (authors) => {
  const formattedAuthors = authors.map((author) => formatSurnameInitials(author, false)).filter(Boolean);

  if (!formattedAuthors.length) return '';
  if (formattedAuthors.length <= 3) return `${formattedAuthors.join(', ')} `;
  return `${formattedAuthors[0]} [и др.] `;
};

const formatResponsibilityAuthors2008 = (authors) => {
  const formattedAuthors = authors.map(formatInitialsSurname).filter(Boolean);

  if (!formattedAuthors.length) return '';
  if (formattedAuthors.length <= 3) return formattedAuthors.join(', ');
  return `${formattedAuthors[0]} [и др.]`;
};

const formatGostReference2008 = (node, index) => {
  const paper = getPaperData(node);
  const authors = formatGostAuthors2008(paper.authors);
  const title = formatArticleTitle(paper.title);
  const responsibility = formatResponsibilityAuthors2008(paper.authors);
  const responsibilityPart = responsibility ? ` / ${responsibility}` : '';
  const journal = paper.source ? ` // ${paper.source}.` : '';
  const mainSeparator = journal ? '' : '.';
  const year = paper.year ? ` — ${paper.year}.` : '';
  const volumeIssue = formatVolumeIssue(paper.volume, paper.issue);
  const volumeIssuePart = volumeIssue ? ` — ${volumeIssue}.` : '';
  const pages = formatPages(paper);
  const pagesPart = pages ? ` — С. ${pages}.` : '';
  const doi = paper.doi ? ` — DOI: ${paper.doi}.` : '';
  const urlValue = paper.url || (paper.doi ? `https://doi.org/${paper.doi}` : '');
  const url = urlValue ? ` — URL: ${urlValue} (дата обращения: ${getToday()}).` : '';

  return normalizeText(
    `${index + 1}. ${authors}${title} [Электронный ресурс]${responsibilityPart}${mainSeparator}`
    + `${journal}${year}${volumeIssuePart}${pagesPart}${doi}${url}`,
  );
};

const formatGost2008 = (nodes) => nodes.map(formatGostReference2008).join('\n\n');

const formatGost2018Heading = (authors) => {
  if (!authors.length) return '';

  const firstAuthor = formatSurnameInitials(authors[0], true);
  return firstAuthor ? `${stripTrailingPeriod(firstAuthor)}. ` : '';
};

const formatResponsibilityAuthors2018 = (authors) => {
  const formattedAuthors = authors.map(formatInitialsSurname).filter(Boolean);

  if (!formattedAuthors.length) return '';
  if (formattedAuthors.length <= 3) return formattedAuthors.join(', ');
  return `${formattedAuthors.slice(0, 3).join(', ')} [et al.]`;
};

const formatGost2018Reference = (node, index) => {
  const paper = getPaperData(node);
  const title = formatArticleTitle(paper.title);
  const heading = formatGost2018Heading(paper.authors);
  const responsibility = formatResponsibilityAuthors2018(paper.authors);
  const responsibilityPart = responsibility ? ` / ${responsibility}` : '';
  const journal = paper.source ? ` // ${paper.source}.` : '';
  const mainSeparator = journal ? '' : '.';
  const year = paper.year ? ` — ${paper.year}.` : '';
  const volumeIssue = formatVolumeIssue(paper.volume, paper.issue);
  const volumeIssuePart = volumeIssue ? ` — ${volumeIssue}.` : '';
  const pages = formatPages(paper);
  const pagesPart = pages ? ` — С. ${pages}.` : '';
  const doi = paper.doi ? ` — DOI: ${paper.doi}.` : '';
  const shouldShowUrl = paper.url && (!paper.doi || !paper.url.includes(paper.doi));
  const url = shouldShowUrl ? ` — URL: ${paper.url} (дата обращения: ${getToday()}).` : '';
  const electronicText = paper.url || paper.doi ? ' — Текст : электронный.' : '';

  return normalizeText(
    `${index + 1}. ${heading}${title}${responsibilityPart}${mainSeparator}`
    + `${journal}${year}${volumeIssuePart}${pagesPart}${doi}${url}${electronicText}`,
  );
};

const formatGost2018 = (nodes) => nodes.map(formatGost2018Reference).join('\n\n');

const makeBibKey = (paper, index) => {
  const { family } = parseAuthorName(paper.authors[0] || 'paper');
  const titlePart = paper.title.split(/\s+/).find((word) => word.length > 4) || 'work';
  return `${family || 'paper'}${paper.year || 'nd'}${titlePart}${index + 1}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
};

const formatBibTeX = (nodes) => nodes.map((node, index) => {
  const paper = getPaperData(node);
  const fields = [
    `  title = {${escapeBibTeX(paper.title)}}`,
    paper.authors.length ? `  author = {${paper.authors.map(escapeBibTeX).join(' and ')}}` : null,
    paper.year ? `  year = {${paper.year}}` : null,
    paper.source ? `  journal = {${escapeBibTeX(paper.source)}}` : null,
    paper.volume ? `  volume = {${paper.volume}}` : null,
    paper.issue ? `  number = {${paper.issue}}` : null,
    formatPages(paper) ? `  pages = {${formatPages(paper)}}` : null,
    paper.doi ? `  doi = {${paper.doi}}` : null,
    paper.url ? `  url = {${paper.url}}` : null,
  ].filter(Boolean);

  return `@article{${makeBibKey(paper, index)},\n${fields.join(',\n')}\n}`;
}).join('\n\n');

const formatMarkdown = (nodes) => nodes.map((node, index) => {
  const paper = getPaperData(node);
  const authors = paper.authors.length ? paper.authors.join(', ') : 'Автор не указан';
  const year = paper.year || 'год не указан';
  const link = paper.url ? ` [Открыть](${paper.url})` : '';

  return `${index + 1}. **${paper.title}**. ${authors}. ${year}.${link}`;
}).join('\n');

const formatJson = (nodes) => JSON.stringify(nodes.map(getPaperData), null, 2);

export const buildExportContent = (nodes = [], format = 'gost_2018') => {
  const paperNodes = getPaperNodes(nodes);

  if (format === 'gost_2018') return formatGost2018(paperNodes);
  if (format === 'bibtex') return formatBibTeX(paperNodes);
  if (format === 'markdown') return formatMarkdown(paperNodes);
  if (format === 'json') return formatJson(paperNodes);

  return formatGost2008(paperNodes);
};

const encodeRtfText = (text) => String(text).split('').map((char) => {
  if (char === '\\') return '\\\\';
  if (char === '{') return '\\{';
  if (char === '}') return '\\}';
  if (char === '\n') return '\\par\n';

  const code = char.charCodeAt(0);
  if (code > 127) {
    const signedCode = code > 32767 ? code - 65536 : code;
    return `\\u${signedCode}?`;
  }

  return char;
}).join('');

export const prepareDownloadContent = (content, downloadType) => {
  if (downloadType !== 'rtf') return content;
  return `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\fs24\n${encodeRtfText(content)}\n}`;
};

export const downloadTextFile = (content, filename, downloadType) => {
  const type = DOWNLOAD_TYPES[downloadType] || DOWNLOAD_TYPES.txt;
  const blob = new Blob([prepareDownloadContent(content, downloadType)], { type: type.mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = `${filename}.${type.extension}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

export const makeExportFilename = (scopeLabel, format) => `${scopeLabel}-${format}`
  .toLowerCase()
  .replace(/[^a-zа-яё0-9]+/gi, '-')
  .replace(/^-|-$/g, '') || 'research-export';
