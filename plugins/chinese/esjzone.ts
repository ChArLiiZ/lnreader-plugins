import { load as parseHTML } from 'cheerio';
import { fetchText } from '@libs/fetch';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { defaultCover } from '@libs/defaultCover';

class ESJZone implements Plugin.PluginBase {
  id = 'esjzone';
  name = 'ESJZone';
  icon = 'src/cn/esjzone/icon.png';
  site = 'https://www.esjzone.cc';
  version = '1.0.0';

  // Allow WebView login for R18/member-only content
  webStorageUtilized = true;

  async popularNovels(
    pageNo: number,
    { filters }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    let url: string;

    const tag = filters?.tag?.value;
    if (tag && tag.trim() !== '') {
      // Tag-based browsing
      url =
        pageNo === 1
          ? `${this.site}/tags/${encodeURI(tag.trim())}/`
          : `${this.site}/tags/${encodeURI(tag.trim())}/${pageNo}.html`;
    } else {
      // Default list (原創小說)
      url =
        pageNo === 1
          ? `${this.site}/list-21/`
          : `${this.site}/list-21/${pageNo}.html`;
    }

    const body = await fetchText(url);
    if (body === '') throw Error('無法獲取小說列表，請檢查網路');

    return this.parseNovelList(body);
  }

  private parseNovelList(body: string): Plugin.NovelItem[] {
    const $ = parseHTML(body);
    const novels: Plugin.NovelItem[] = [];

    $('div.card.mb-30').each((_i, el) => {
      const cardEl = $(el);
      const linkEl = cardEl.find('a.card-img-tiles');
      const href = linkEl.attr('href');
      if (!href) return;

      const novelName = cardEl.find('.card-title a').text().trim();
      let novelCover =
        cardEl.find('.main-img .lazyload').attr('data-src') || '';

      // Skip placeholder empty covers
      if (novelCover.includes('/assets/img/empty.jpg') || novelCover === '') {
        novelCover = defaultCover;
      } else if (novelCover.startsWith('/') && !novelCover.startsWith('//')) {
        novelCover = this.site + novelCover;
      }

      novels.push({
        name: novelName,
        path: href, // e.g. /detail/1684898804.html
        cover: novelCover,
      });
    });

    return novels;
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const url = this.site + novelPath;
    const body = await fetchText(url);
    if (body === '') throw Error('無法獲取小說資訊，請檢查網路');

    const $ = parseHTML(body);

    // Detect login-required / redirected pages
    const pageText = $('body').text();
    const hasLoginPrompt =
      pageText.includes('請先登入') ||
      pageText.includes('请先登入') ||
      pageText.includes('登入 / 註冊');
    const titleEl = $('h2.text-normal');
    const hasNovelContent = titleEl.length > 0;

    // If page has no novel content and seems to require login
    if (!hasNovelContent && hasLoginPrompt) {
      const novel: Plugin.SourceNovel = {
        path: novelPath,
        chapters: [],
        name: '需要登入才能瀏覽此作品',
        summary:
          '此作品（日韓翻譯小說等）需要登入 ESJZone 帳號才能瀏覽。\n' +
          '請在 WebView 中開啟此頁面並登入後重試。',
      };
      novel.cover = defaultCover;
      return novel;
    }

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      chapters: [],
      name: titleEl.text().trim() || 'Untitled',
    };

    // Cover image
    const coverImg = $('div.product-gallery img').attr('src') || '';
    if (coverImg) {
      novel.cover = coverImg.startsWith('/') ? this.site + coverImg : coverImg;
    } else {
      novel.cover = defaultCover;
    }

    // Parse metadata from book-detail list
    $('ul.book-detail li').each((_i, el) => {
      const text = $(el).text().trim();
      if (text.startsWith('作者:') || text.startsWith('作者：')) {
        novel.author =
          $(el).find('a').text().trim() || text.replace(/作者[:：]\s*/, '');
      }
      if (text.startsWith('類型:') || text.startsWith('類型：')) {
        // Type info (e.g. 原創)
        const typeText = text.replace(/類型[:：]\s*/, '').trim();
        if (typeText) {
          novel.status = typeText.includes('完結')
            ? NovelStatus.Completed
            : NovelStatus.Ongoing;
        }
      }
      if (text.startsWith('更新日期:') || text.startsWith('更新日期：')) {
        // We don't have a field for last update in SourceNovel,
        // but we can use it to determine ongoing status
      }
    });

    // Default status to Ongoing if not set
    if (!novel.status) {
      novel.status = NovelStatus.Ongoing;
    }

    // Rating
    const ratingText = $('div.d-inline.display-3').first().text().trim();
    if (ratingText) {
      const rating = parseFloat(ratingText);
      if (!isNaN(rating)) {
        novel.rating = rating;
      }
    }

    // Summary
    const summaryEl = $('div.description');
    if (summaryEl.length) {
      novel.summary = summaryEl.text().trim();
    }

    // Tags / Genres
    const tags: string[] = [];
    $('section.widget-tags a.tag').each((_i, el) => {
      const tagText = $(el).text().trim();
      if (tagText) tags.push(tagText);
    });
    // Also check sidebar tags (visible on larger screens)
    if (tags.length === 0) {
      $('a.tag').each((_i, el) => {
        const href = $(el).attr('href') || '';
        if (href.startsWith('/tags/')) {
          const tagText = $(el).text().trim();
          if (tagText && !tags.includes(tagText)) {
            tags.push(tagText);
          }
        }
      });
    }
    if (tags.length > 0) {
      novel.genres = tags.join(',');
    }

    // Chapters from #chapterList
    const chapters: Plugin.ChapterItem[] = [];
    let chapterNumber = 0;

    $('#chapterList a').each((_i, el) => {
      const chapterHref = $(el).attr('href');
      if (!chapterHref) return;

      const chapterName =
        $(el).attr('data-title')?.trim() || $(el).text().trim();
      if (!chapterName) return;

      chapterNumber++;

      // Convert absolute URL to relative path
      let chapterPath = chapterHref;
      if (chapterPath.startsWith(this.site)) {
        chapterPath = chapterPath.replace(this.site, '');
      } else if (chapterPath.startsWith('https://www.esjzone.cc')) {
        chapterPath = chapterPath.replace('https://www.esjzone.cc', '');
      }

      chapters.push({
        name: chapterName,
        path: chapterPath,
        chapterNumber: chapterNumber,
      });
    });

    novel.chapters = chapters;
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const url = this.site + chapterPath;
    const body = await fetchText(url);
    if (body === '') throw Error('無法獲取章節內容，請檢查網路');

    const $ = parseHTML(body);

    // Detect login-required pages
    const pageText = $('body').text();
    const hasForumContent = $('div.forum-content').length > 0;

    if (
      pageText.includes('請先登入') ||
      pageText.includes('请先登入') ||
      pageText.includes('請登入後再訪問') ||
      pageText.includes('需要登入') ||
      (!hasForumContent && pageText.includes('登入 / 註冊'))
    ) {
      return '<p style="text-align:center;color:red;font-weight:bold;">此內容需要登入才能閱讀。請在 WebView 中登入 ESJZone 帳號後重試。</p>';
    }

    // Detect adult verification pages
    if (
      pageText.includes('成人確認') ||
      pageText.includes('年齡確認') ||
      pageText.includes('未成年請勿') ||
      pageText.includes('18歲以上')
    ) {
      return '<p style="text-align:center;color:red;font-weight:bold;">此內容需要成人驗證。請在 WebView 中完成年齡確認後重試。</p>';
    }

    // Detect password-protected chapters
    if (
      pageText.includes('密碼') ||
      pageText.includes('密码') ||
      $('input[type="password"]').length > 0
    ) {
      return '<p style="text-align:center;color:red;font-weight:bold;">此章節受密碼保護，無法直接閱讀。</p>';
    }

    // Extract chapter content
    const contentEl = $('div.forum-content');
    if (contentEl.length === 0) {
      return '<p>無法找到章節內容。</p>';
    }

    // Clean up the content
    // Remove script tags, ads, etc.
    contentEl.find('script, style, .ad, ins.adsbygoogle').remove();

    const chapterText = contentEl.html() || '';
    return chapterText;
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    // ESJZone uses tag-based search at /tags/{term}/
    const url =
      pageNo === 1
        ? `${this.site}/tags/${encodeURI(searchTerm)}/`
        : `${this.site}/tags/${encodeURI(searchTerm)}/${pageNo}.html`;

    const body = await fetchText(url);
    if (body === '') return [];

    return this.parseNovelList(body);
  }

  resolveUrl = (path: string) => this.site + path;

  filters = {
    tag: {
      label: '標籤篩選',
      value: '',
      type: FilterTypes.TextInput,
    },
  } satisfies Filters;
}

export default new ESJZone();
