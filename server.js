const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cron = require('node-cron');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let priceCache = {
    lastUpdated: null,
    goldPricePerGram: null,
    products: [],
    status: 'pending',
    error: null
};

const productConfig = [
    { id: '1g-minted', weight: 1, type: 'minted', category: 'Minted Bars' },
    { id: '5g-minted', weight: 5, type: 'minted', category: 'Minted Bars' },
    { id: '50g-minted', weight: 50, type: 'minted', category: 'Minted Bars' },
    { id: '100g-minted', weight: 100, type: 'minted', category: 'Minted Bars' },
    { id: '5g-lunar', weight: 5, type: 'lunar', category: 'Minted Bars' },
    { id: '10g-cast', weight: 10, type: 'cast', category: 'Cast Bars' },
    { id: '20g-cast', weight: 20, type: 'cast', category: 'Cast Bars' },
    { id: '50g-cast', weight: 50, type: 'cast', category: 'Cast Bars' },
    { id: '100g-cast', weight: 100, type: 'cast', category: 'Cast Bars' },
    { id: '1oz-lunar', weight: 31.1035, type: 'lunar-oz', category: 'Cast Bars' }
];

const premiums = {
    minted: { 1: 0.13, 5: 0.06, 50: 0.01, 100: 0.005 },
    cast: { 10: 0.045, 20: 0.025, 50: 0.00, 100: -0.005 },
    lunar: 0.065,
    'lunar-oz': 0.03
};

async function scrapeMKSPamp() {
    console.log('[' + new Date().toISOString() + '] Scraping MKS PAMP...');
    let browser;

    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--single-process'
            ]
        });

        const page = await browser.newPage();

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        await page.setViewport({ width: 1920, height: 1080 });

        console.log('Navigating to MKS PAMP...');
        await page.goto('https://www.mkspamp.com.my/pricing', {
            waitUntil: 'networkidle2',
            timeout: 60000
        });

        // Wait for page to fully load
        await page.waitForSelector('body', { timeout: 30000 });

        // Wait a bit for any JavaScript to execute
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Extract gold price
        const goldPrice = await page.evaluate(() => {
            const bodyText = document.body.innerText;

            // Look for gold price patterns - MKS PAMP shows price per gram
            // Try various patterns
            const patterns = [
                /gold.*?sell.*?(\d{3}(?:\.\d{2})?)/i,
                /sell.*?gold.*?(\d{3}(?:\.\d{2})?)/i,
                /(\d{3}(?:\.\d{2})?)\s*(?:RM|MYR)?\s*(?:per|\/)\s*(?:gram|g)/i,
                /gold\s*999.*?(\d{3}(?:\.\d{2})?)/i,
                /fine\s*gold.*?(\d{3}(?:\.\d{2})?)/i
            ];

            for (const pattern of patterns) {
                const match = bodyText.match(pattern);
                if (match) {
                    const price = parseFloat(match[1]);
                    if (price > 200 && price < 1000) {
                        return price;
                    }
                }
            }

            // Try finding in tables
            const tables = document.querySelectorAll('table');
            for (const table of tables) {
                const text = table.innerText.toLowerCase();
                if (text.includes('gold') || text.includes('sell')) {
                    const priceMatch = table.innerText.match(/(\d{3}(?:\.\d{2})?)/);
                    if (priceMatch) {
                        const price = parseFloat(priceMatch[1]);
                        if (price > 200 && price < 1000) {
                            return price;
                        }
                    }
                }
            }

            // Try finding any 3-digit number that looks like a gold price
            const allNumbers = bodyText.match(/\b(\d{3}(?:\.\d{2})?)\b/g);
            if (allNumbers) {
                for (const num of allNumbers) {
                    const price = parseFloat(num);
                    // Gold price per gram is typically 400-800 RM in Malaysia
                    if (price >= 400 && price <= 800) {
                        return price;
                    }
                }
            }

            return null;
        });

        await browser.close();

        if (goldPrice) {
            priceCache.goldPricePerGram = goldPrice;
            priceCache.lastUpdated = new Date().toISOString();
            priceCache.status = 'success';
            priceCache.error = null;
            calculateProductPrices();
            console.log('SUCCESS: Gold price = RM ' + goldPrice);
        } else {
            throw new Error('Could not find gold price on page');
        }

    } catch (error) {
        console.error('Scrape error:', error.message);
        priceCache.status = 'error';
        priceCache.error = error.message;
        if (browser) await browser.close();
    }
}

function calculateProductPrices() {
    if (!priceCache.goldPricePerGram) return;
    const basePrice = priceCache.goldPricePerGram;

    priceCache.products = productConfig.map(product => {
        let premium = 0;
        if (product.type === 'minted') premium = premiums.minted[product.weight] || 0.05;
        else if (product.type === 'cast') premium = premiums.cast[product.weight] || 0.02;
        else if (product.type === 'lunar') premium = premiums.lunar;
        else if (product.type === 'lunar-oz') premium = premiums['lunar-oz'];

        const price = Math.round(basePrice * product.weight * (1 + premium));
        return { ...product, price, priceFormatted: 'RM ' + price.toLocaleString() };
    });
}

app.get('/api/prices', (req, res) => res.json(priceCache));

app.post('/api/refresh', async (req, res) => {
    await scrapeMKSPamp();
    res.json(priceCache);
});

app.get('/api/health', (req, res) => res.json({
    status: 'ok',
    lastUpdated: priceCache.lastUpdated,
    priceStatus: priceCache.status
}));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Auto-refresh every 5 minutes
cron.schedule('*/5 * * * *', () => {
    console.log('Scheduled refresh...');
    scrapeMKSPamp();
});

app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Fetching initial prices from MKS PAMP...');
    await scrapeMKSPamp();
});
