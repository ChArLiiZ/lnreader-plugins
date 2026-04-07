import { load as parseHTML } from 'cheerio';
import { fetchText } from '@libs/fetch';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { defaultCover } from '@libs/defaultCover';
import { storage } from '@libs/storage';

type NovelListItem = Plugin.NovelItem & { genres?: string };
type TagOption = { label: string; value: string };
type StoredTagMap = Record<string, string>;

const COLLECTED_TAGS_KEY = 'linovelib_tw_collected_tags';

class LinovelibTw implements Plugin.PluginBase {
  id = 'linovelib_tw';
  name = 'Linovelib TW';
  icon = 'src/cn/linovelib/icon.png';
  site = 'https://tw.linovelib.com';
  version = '1.2.0';
  imageRequestInit?: Plugin.ImageRequestInit = {
    method: 'GET',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
      Referer: 'https://tw.linovelib.com/',
      Accept:
        'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    },
  };

  private refreshTagOptions(): void {
    const saved = this.getStoredTagMap();
    this.filters.customTag.options = Object.entries(saved)
      .sort(([left], [right]) => left.localeCompare(right, 'zh-Hant'))
      .map(([label, value]) => ({ label, value }));
  }

  private getStoredTagMap(): StoredTagMap {
    return (storage.get(COLLECTED_TAGS_KEY) as StoredTagMap | undefined) || {};
  }

  private collectTags(tags: TagOption[]): void {
    if (tags.length === 0) return;

    const saved = this.getStoredTagMap();
    let changed = false;

    tags.forEach(tag => {
      const label = this.cleanText(tag.label);
      const value = this.cleanText(tag.value);
      if (!label || !value) return;
      if (saved[label] === value) return;

      saved[label] = value;
      changed = true;
    });

    if (changed) {
      storage.set(COLLECTED_TAGS_KEY, saved);
      this.refreshTagOptions();
    }
  }

  private getSelectedTagPaths(
    filters?: Plugin.PopularNovelsOptions<typeof this.filters>['filters'],
  ): string[] {
    const customTag = filters?.customTag?.value as unknown;
    if (Array.isArray(customTag)) {
      return customTag
        .filter(value => typeof value === 'string' && value.trim() !== '')
        .map(value => value.trim());
    }
    if (typeof customTag === 'string' && customTag.trim() !== '') {
      return [customTag.trim()];
    }
    return [];
  }

  private makeAbsolute(url?: string | null): string {
    if (!url) return defaultCover;
    if (url.startsWith('//')) return `https:${url}`;
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('/')) return `${this.site}${url}`;
    return `${this.site}/${url}`;
  }

  private cleanText(text?: string | null): string {
    return text?.replace(/\s+/g, ' ').trim() || '';
  }

  private parseWordCount(text: string): number | undefined {
    const normalized = this.cleanText(text);
    const match = normalized.match(/([\d.]+)\s*([萬亿億千]?)字?/);
    if (!match) return undefined;

    const value = parseFloat(match[1]);
    if (Number.isNaN(value)) return undefined;

    const unit = match[2];
    if (unit === '萬') return Math.round(value * 10000);
    if (unit === '亿' || unit === '億') return Math.round(value * 100000000);
    if (unit === '千') return Math.round(value * 1000);
    return Math.round(value);
  }

  private parseTagNames(text: string): string[] {
    return this.cleanText(text)
      .split(/\s+/)
      .map(tag => tag.trim())
      .filter(Boolean);
  }

  private parseNovelList(body: string): Plugin.NovelItem[] {
    const $ = parseHTML(body);
    const novels: Plugin.NovelItem[] = [];

    $(
      '.book-ol .book-li a.book-layout, .module-rank-booklist .book-li a.book-layout',
    ).each((_i, el) => {
      const itemEl = $(el);
      const path = itemEl.attr('href');
      if (!path) return;

      const cover =
        itemEl.find('.book-cover img').attr('data-src') ||
        itemEl.find('.book-cover img').attr('src');
      const rating = this.cleanText(itemEl.find('.corner em').text());
      const wordText = this.cleanText(itemEl.find('.tag-small.blue').text());
      const tags = this.parseTagNames(itemEl.find('.tag-small.yellow').text());

      const infoParts: string[] = [];
      if (rating) infoParts.push(`★${rating}`);
      if (wordText) infoParts.push(`${wordText}字`);

      const novel: NovelListItem = {
        name: this.cleanText(itemEl.find('.book-title').text()),
        path,
        cover: this.makeAbsolute(cover),
      };

      const author = this.cleanText(itemEl.find('.book-author').text());
      if (infoParts.length > 0) {
        novel.info = infoParts.join(' | ');
      } else if (author) {
        novel.info = author;
      }

      if (tags.length > 0) {
        novel.genres = tags.join(',');
      }

      novels.push(novel);
    });

    return novels;
  }

  private async fetchTagPage(
    tagPath: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    if (!tagPath) return [];

    const pagedPath = tagPath.replace(/_(\d+)_0\.html$/, `_${pageNo}_0.html`);
    const body = await this.fetchPage(this.makeAbsolute(pagedPath));
    return this.parseNovelList(body);
  }

  private async fetchMultiTagNovels(
    tagPaths: string[],
    rank: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const normalizedPaths = Array.from(
      new Set(
        tagPaths.map(path => this.applyRankToTagPath(path, rank, pageNo)),
      ),
    );
    if (normalizedPaths.length === 0) return [];

    const tagResults = await Promise.all(
      normalizedPaths.map(tagPath => this.fetchTagPage(tagPath, pageNo)),
    );
    if (tagResults.length === 0) return [];

    const [primaryResults, ...otherResults] = tagResults;
    if (otherResults.length === 0) return primaryResults;

    const allowedPaths = otherResults.map(
      novels => new Set(novels.map(novel => novel.path)),
    );

    return primaryResults.filter(novel =>
      allowedPaths.every(pathSet => pathSet.has(novel.path)),
    );
  }

  private applyRankToTagPath(
    tagPath: string,
    rank: string,
    pageNo: number,
  ): string {
    const normalizedPath = this.cleanText(tagPath);
    if (!normalizedPath.includes('/wenku/')) {
      return normalizedPath;
    }

    const match = normalizedPath.match(
      /\/wenku\/([^_/]+)_(\d+)_0_0_0_0_0_0_(\d+)_0\.html$/,
    );
    if (!match) {
      return normalizedPath;
    }

    const tagId = match[2];
    return `/wenku/${rank}_${tagId}_0_0_0_0_0_0_${pageNo}_0.html`;
  }

  private async warmTagOptions(novels: Plugin.NovelItem[]): Promise<void> {
    const storedCount = Object.keys(this.getStoredTagMap()).length;
    if (storedCount >= 12) return;

    const targets = novels.slice(0, 3);
    for (const novel of targets) {
      try {
        const body = await this.fetchPage(this.makeAbsolute(novel.path));
        const $ = parseHTML(body);
        const tags = $('#bookDetailWrapper .tag-small a')
          .map((_i, el) => ({
            label: this.cleanText($(el).text()),
            value: this.cleanText($(el).attr('href')),
          }))
          .toArray()
          .filter(tag => tag.label && tag.value);
        this.collectTags(tags);
      } catch {
        // Ignore warm-up failures and keep the list usable.
      }
    }
  }

  private async fetchPage(url: string): Promise<string> {
    const body = await fetchText(url, {
      headers: {
        Referer: this.site,
      },
    });
    if (body === '') throw new Error(`Failed to fetch ${url}`);
    return body;
  }

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    this.refreshTagOptions();

    const rank = showLatestNovels ? 'postdate' : filters.rank.value;
    const selectedTagPaths = this.getSelectedTagPaths(filters);
    if (selectedTagPaths.length > 0) {
      const tagNovels = await this.fetchMultiTagNovels(
        selectedTagPaths,
        rank,
        pageNo,
      );
      if (tagNovels.length > 0) {
        return tagNovels;
      }
    }

    const url = `${this.site}/wenku/${rank}_0_0_0_0_0_0_0_${pageNo}_0.html`;

    const body = await this.fetchPage(url);
    const novels = this.parseNovelList(body);
    await this.warmTagOptions(novels);
    return novels;
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const body = await this.fetchPage(this.makeAbsolute(novelPath));
    const $ = parseHTML(body);

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      chapters: [],
      name: this.cleanText($('#bookDetailWrapper .book-title').first().text()),
      cover: this.makeAbsolute(
        $('#bookDetailWrapper img.book-cover').attr('src') ||
          $('#bookDetailWrapper img.book-cover').attr('data-src'),
      ),
      summary: this.cleanText(
        $('#bookSummary .content, #bookSummary').first().text(),
      ),
      author: this.cleanText(
        $('#bookDetailWrapper .authorname a').first().text(),
      ),
    };

    const translator = this.cleanText(
      $('#bookDetailWrapper .book-rand-a a').eq(1).text(),
    );
    if (translator) {
      novel.artist = translator;
    }

    const metaText = this.cleanText(
      $('#bookDetailWrapper .book-meta.book-layout-inline').last().text(),
    );
    novel.status = metaText.includes('完結')
      ? NovelStatus.Completed
      : NovelStatus.Ongoing;

    const ratingText = this.cleanText($('.score-num').first().text());
    if (ratingText) {
      const rating = parseFloat(ratingText);
      if (!Number.isNaN(rating)) {
        novel.rating = rating;
      }
    }

    const wordMeta = metaText
      .split('|')
      .map(part => this.cleanText(part))
      .find(part => part.includes('字'));
    if (wordMeta) {
      novel.wordCount = this.parseWordCount(wordMeta);
    }

    const tags = $('#bookDetailWrapper .tag-small a')
      .map((_i, el) => ({
        label: this.cleanText($(el).text()),
        value: this.cleanText($(el).attr('href')),
      }))
      .toArray()
      .filter(tag => tag.label && tag.value);
    this.collectTags(tags);

    const tagLabels = tags.map(tag => tag.label);
    if (tagLabels.length > 0) {
      novel.genres = tagLabels.join(',');
    }

    const catalogPath = $('#btnReadBook').attr('href');
    if (!catalogPath) {
      return novel;
    }

    const catalogBody = await this.fetchPage(this.makeAbsolute(catalogPath));
    const chapters$ = parseHTML(catalogBody);
    let volumeName = '';
    let chapterNumber = 0;

    chapters$('#volumes .chapter-li').each((_i, el) => {
      const row = chapters$(el);
      if (row.hasClass('chapter-bar')) {
        volumeName = this.cleanText(row.find('h3').text());
        return;
      }
      if (row.hasClass('volume-cover')) {
        return;
      }

      const link = row.find('a.chapter-li-a');
      const path = link.attr('href');
      if (!path) return;

      const chapterTitle = this.cleanText(row.find('.chapter-index').text());
      if (!chapterTitle) return;

      chapterNumber += 1;
      novel.chapters.push({
        name: volumeName ? `${volumeName} ${chapterTitle}` : chapterTitle,
        path,
        chapterNumber,
      });
    });

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const body = await this.fetchPage(this.makeAbsolute(chapterPath));
    const $ = parseHTML(body);
    const content = $('#acontent');

    content.find('script, .cgo').remove();
    content.find('center').each((_i, el) => {
      const text = this.cleanText($(el).text());
      if (text.includes('暫不支持') || text.includes('請使用手機閱讀')) {
        $(el).remove();
      }
    });

    content.find('img.imagecontent').each((_i, el) => {
      const src = $(el).attr('data-src') || $(el).attr('src');
      if (src) {
        $(el)
          .attr('src', this.makeAbsolute(src))
          .removeAttr('data-src')
          .removeClass('lazyload');
      }
    });

    const title = this.cleanText($('#atitle + h3').text());
    const chapterTitle = this.cleanText($('#atitle').text());
    const chapterName = [title, chapterTitle].filter(Boolean).join(' ');
    const html = content.html()?.trim() || '';

    return chapterName ? `<h2>${chapterName}</h2>${html}` : html;
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    this.refreshTagOptions();

    const storedTagPath = this.getStoredTagMap()[searchTerm];
    const tagNovels = storedTagPath
      ? await this.fetchTagPage(storedTagPath, pageNo)
      : [];
    if (tagNovels.length > 0) {
      return tagNovels;
    }

    const searchUrl = `${this.site}/search/${encodeURI(searchTerm)}_${pageNo}.html`;

    try {
      const body = await this.fetchPage(searchUrl);
      const novels = this.parseNovelList(body);
      if (novels.length > 0) {
        await this.warmTagOptions(novels);
        return novels;
      }
    } catch {
      // The site search route is unstable, so fall back to recent pages.
    }

    const normalized = searchTerm.trim().toLowerCase();
    const startPage = (pageNo - 1) * 5 + 1;
    const matched: Plugin.NovelItem[] = [];
    const seen = new Set<string>();

    for (
      let currentPage = startPage;
      currentPage < startPage + 5;
      currentPage += 1
    ) {
      const fallbackBody = await this.fetchPage(
        `${this.site}/wenku/postdate_0_0_0_0_0_0_0_${currentPage}_0.html`,
      );
      const novels = this.parseNovelList(fallbackBody).filter(novel => {
        const genres = (novel as NovelListItem).genres || '';
        return (
          novel.name.toLowerCase().includes(normalized) ||
          genres.toLowerCase().includes(normalized)
        );
      });

      novels.forEach(novel => {
        if (!seen.has(novel.path)) {
          seen.add(novel.path);
          matched.push(novel);
        }
      });

      if (matched.length >= 20) {
        break;
      }
    }

    await this.warmTagOptions(matched);
    return matched;
  }

  filters = {
    rank: {
      label: 'Ranking',
      value: 'monthvisit',
      options: [
        { label: 'Monthly Views', value: 'monthvisit' },
        { label: 'Weekly Views', value: 'weekvisit' },
        { label: 'Monthly Votes', value: 'monthvote' },
        { label: 'Weekly Votes', value: 'weekvote' },
        { label: 'Monthly Flowers', value: 'monthflower' },
        { label: 'Weekly Flowers', value: 'weekflower' },
        { label: 'Monthly Eggs', value: 'monthegg' },
        { label: 'Weekly Eggs', value: 'weekegg' },
        { label: 'Latest Update', value: 'lastupdate' },
        { label: 'New Arrivals', value: 'postdate' },
        { label: 'Rating', value: 'goodnum' },
        { label: 'Trending', value: 'newhot' },
      ],
      type: FilterTypes.Picker,
    },
    customTag: {
      label: 'Tag',
      value: [] as string[],
      options: [] as TagOption[],
      type: FilterTypes.AutocompleteMulti,
    },
  } satisfies Filters;
}

export default new LinovelibTw();
