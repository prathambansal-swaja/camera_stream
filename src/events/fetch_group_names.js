const puppeteer = require('puppeteer');

const BASE_URL = 'https://192.168.1.2';
const USERNAME = 'admin';
const PASSWORD = 'admin'; 

async function executeUniversalPipeline() {
  console.log('Step 1: Spawning visible browser window...');
  const browser = await puppeteer.launch({
    headless: false, // Leave visible so you can see it physically break past the login page!
    args: [
      '--ignore-certificate-errors',
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });

    console.log('Step 2: Navigating to the camera login interface...');
    await page.authenticate({ username: USERNAME, password: PASSWORD });
    await page.goto(BASE_URL, { waitUntil: 'networkidle2' });

    console.log('Step 3: Simulating physical user interactions on the login form...');
    const passwordInputSelector = 'input[type="password"]';
    await page.waitForSelector(passwordInputSelector, { timeout: 6000 });
    
    // HUMAN SIMULATION A: Focus the element, clear it, and type at human speed
    const passwordField = await page.$(passwordInputSelector);
    const box = await passwordField.boundingBox();
    
    // Physically move the mouse to the center of the password box and click it
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    
    // Clear any autofilled data
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    
    // Type out the password string character by character with an algorithmic delay
    await page.type(passwordInputSelector, PASSWORD, { delay: 100 });

    // HUMAN SIMULATION B: Move and click the submit layout trigger
    const loginButtonSelector = 'button, .login-btn, input[type="submit"]';
    const loginButton = await page.$(loginButtonSelector);
    const btnBox = await loginButton.boundingBox();
    
    // Physically move the mouse cursor over to the login button and click it
    await page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
    
    console.log('Form submission fired! Waiting 8 seconds for the dashboard page to mount layout frames...');
    await new Promise(resolve => setTimeout(resolve, 8000));

    console.log('Step 4: Looking for dashboard layout indicators...');
    
    // Let's re-evaluate the text items visible on the screen to confirm we got past the login barrier
    const postLoginUIElements = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('li, button, a, .menu-item, span, label'))
        .map(el => el.innerText.trim())
        .filter(text => text.length > 0);
    });

    console.log('\nVisible elements on the screen now:', postLoginUIElements.slice(0, 15));

    const targetContainerSelector = '#circleInfoBox';
    const boxExists = await page.evaluate((selector) => !!document.querySelector(selector), targetContainerSelector);

    if (!boxExists) {
      console.log(`\nThe #circleInfoBox component is still missing from the active layout structure.`);
      console.log('Please check the visible browser window. If it successfully logged in but landed on a different tab,');
      console.log('manually click the "Face Database" tab inside the window right now! Script will wait 15 seconds...');
      await new Promise(resolve => setTimeout(resolve, 15000));
    }

    console.log('\nStep 5: Extracting group names profile list out of the container layout...');

    const groupNames = await page.evaluate((containerId) => {
      // Strategy A: Pull from label configurations inside the box
      const labels = document.querySelectorAll(`${containerId} label`);
      if (labels.length > 0) {
        return Array.from(labels).map(label => label.innerText.trim() || label.getAttribute('title'));
      }
      // Strategy B: Pull from simple data text fields inside the box
      const textBlocks = document.querySelectorAll(`${containerId} .simpleTxt, ${containerId} span`);
      return Array.from(textBlocks).map(el => el.innerText.trim());
    }, targetContainerSelector);

    const cleanGroupNames = groupNames.filter(name => name && name.length > 1);

    if (cleanGroupNames.length > 0) {
      console.log('\n\x1b[32m%s\x1b[0m', 'Successfully Fetched Group Names:', cleanGroupNames);
    } else {
      console.log('No text fragments matched your extraction configuration. Let\'s pull everything inside that box:');
      const rawBoxContent = await page.evaluate((selector) => {
        const el = document.querySelector(selector);
        return el ? el.innerText : 'Box completely missing from page DOM';
      }, targetContainerSelector);
      console.log('Raw Box Text Output:\n', rawBoxContent);
    }

  } catch (err) {
    console.error('\nHoneywell Scraping Failure:', err.message);
  } finally {
    console.log('\nClosing the automation pipeline...');
    await browser.close();
  }
}

executeUniversalPipeline();
