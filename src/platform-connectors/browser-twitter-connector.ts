import { EventEmitter } from 'events';
import { Agent } from '../core/agent';
import { AgentSwarm } from '../core/agent-swarm';
import { Logger } from '../utils/logger';
import puppeteer, { Browser, Page } from 'puppeteer';

/**
 * Configuration for the Twitter connector
 */
export interface BrowserTwitterConnectorConfig {
  // Authentication
  username?: string;
  password?: string;
  email?: string;
  
  // Monitoring options
  monitorKeywords?: string[];
  monitorUsers?: string[];
  autoReply?: boolean;
  
  // Poll interval in milliseconds (default: 60000 = 1 minute)
  pollInterval?: number;
  
  // Browser options
  headless?: boolean; // Whether to run browser in headless mode (default: true)
  debug?: boolean; // Enable additional debugging
}

/**
 * Internal Tweet interface
 */
export interface Tweet {
  id?: string;
  text: string;
  author: {
    id?: string;
    username?: string;
    name?: string;
  };
  createdAt?: Date;
  isRetweet?: boolean;
  isReply?: boolean;
  inReplyToId?: string;
  inReplyToUser?: string;
}

/**
 * Browser-based Twitter connector to integrate agents with Twitter
 * Uses direct browser automation without relying on Twitter API
 */
export class BrowserTwitterConnector extends EventEmitter {
  public config: BrowserTwitterConnectorConfig;
  private agent?: Agent;
  private swarm?: AgentSwarm;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private connected = false;
  private monitorInterval: NodeJS.Timeout | null = null;
  private logger: Logger;

  /**
   * Creates a new Browser Twitter connector
   * 
   * @param config - Configuration options
   */
  constructor(config: BrowserTwitterConnectorConfig) {
    super();
    this.config = {
      ...config,
      pollInterval: config.pollInterval || 60000, // Default: 1 minute
      headless: config.headless !== false, // Default to true unless explicitly set to false
    };
    this.logger = new Logger('BrowserTwitterConnector');
  }

  /**
   * Connects to Twitter with browser automation
   * 
   * @param agent - The agent to connect
   * @returns Promise resolving when connected
   */
  async connect(agent: Agent | AgentSwarm): Promise<void> {
    if (agent instanceof Agent) {
      this.agent = agent;
      this.swarm = undefined;
    } else {
      this.swarm = agent;
      this.agent = undefined;
    }
    
    this.logger.info('Connecting to Twitter');
    
    try {
      // Extract credentials
      const { username, password, email } = this.config;
      
      if (!username || !password) {
        throw new Error('Twitter username and password are required');
      }
      
      // Initialize browser
      this.logger.info('Initializing browser for Twitter operations');
      this.browser = await puppeteer.launch({
        headless: this.config.headless,
        defaultViewport: null,
        args: ['--window-size=1280,800', '--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
      });
      
      // Create page and set viewport
      this.page = await this.browser.newPage();
      await this.page.setViewport({ width: 1280, height: 800 });
      
      // Set user-agent to look like a real browser
      await this.page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
      
      // Login to Twitter
      this.logger.info('Logging in to Twitter');
      await this.browserLogin(username, password, email || '');
      
      this.connected = true;
      this.logger.info('Connected to Twitter successfully');
      
      // Set up monitoring if configured
      if (this.config.monitorKeywords?.length || this.config.monitorUsers?.length) {
        this.setupMonitoring();
      }
    } catch (error) {
      this.logger.error('Failed to connect to Twitter', error);
      
      // Clean up browser if initialization failed
      if (this.browser) {
        await this.browser.close().catch((e: Error) => this.logger.error('Error closing browser', e));
        this.browser = null;
        this.page = null;
      }
      
      throw error;
    }
  }
  
  /**
   * Logs in to Twitter using browser automation
   * 
   * @param username - Twitter username
   * @param password - Twitter password
   * @param email - Optional email for verification
   */
  private async browserLogin(username: string, password: string, email: string): Promise<void> {
    if (!this.page) {
      throw new Error('Browser not initialized');
    }
    
    try {
      // Navigate to Twitter login page
      this.logger.debug('Navigating to Twitter login');
      await this.page.goto('https://twitter.com/i/flow/login', { waitUntil: 'networkidle2' });
      
      // Wait for page to stabilize
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Take screenshot if debugging
      if (this.config.debug) {
        await this.page.screenshot({ path: 'twitter-login.png' });
      }
      
      // Enter username
      this.logger.debug('Entering username');
      await this.page.waitForSelector('input[autocomplete="username"]');
      await this.page.type('input[autocomplete="username"]', username);
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Click Next button
      this.logger.debug('Clicking Next button');
      const nextButtons = await this.page.$$('[role="button"]');
      let nextClicked = false;
      
      for (const button of nextButtons) {
        try {
          const text = await this.page.evaluate(el => el.textContent, button);
          if (text && text.includes('Next')) {
            await button.click();
            this.logger.debug('Clicked Next button');
            nextClicked = true;
            break;
          }
        } catch (err) {
          continue;
        }
      }
      
      if (!nextClicked) {
        this.logger.warn('Could not find Next button, trying to press Enter');
        await this.page.keyboard.press('Enter');
      }
      
      // Wait for page to process
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Check if we need additional verification
      const verifyInput = await this.page.$('input[data-testid="ocfEnterTextTextInput"]');
      if (verifyInput) {
        this.logger.debug('Email verification needed');
        
        if (!email) {
          throw new Error('Email verification required but no email provided');
        }
        
        // Enter email
        await verifyInput.type(email);
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Click Next for verification
        const verifyNextButtons = await this.page.$$('[role="button"]');
        let verifyNextClicked = false;
        
        for (const button of verifyNextButtons) {
          try {
            const text = await this.page.evaluate(el => el.textContent, button);
            if (text && text.includes('Next')) {
              await button.click();
              this.logger.debug('Clicked verification Next button');
              verifyNextClicked = true;
              break;
            }
          } catch (err) {
            continue;
          }
        }
        
        if (!verifyNextClicked) {
          this.logger.warn('Could not find verification Next button, trying to press Enter');
          await this.page.keyboard.press('Enter');
        }
        
        // Wait for page to process
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      // Enter password
      this.logger.debug('Entering password');
      await this.page.waitForSelector('input[name="password"]');
      await this.page.type('input[name="password"]', password);
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Click Log in button
      this.logger.debug('Clicking Log in button');
      const loginButtons = await this.page.$$('[role="button"]');
      let loginClicked = false;
      
      for (const button of loginButtons) {
        try {
          const text = await this.page.evaluate(el => el.textContent, button);
          if (text && (text.includes('Log in') || text.includes('Sign in'))) {
            await button.click();
            this.logger.debug('Clicked Log in button');
            loginClicked = true;
            break;
          }
        } catch (err) {
          continue;
        }
      }
      
      if (!loginClicked) {
        this.logger.warn('Could not find Log in button, trying to press Enter');
        await this.page.keyboard.press('Enter');
      }
      
      // Wait for navigation to home page
      this.logger.debug('Waiting for login completion');
      await this.page.waitForNavigation({ waitUntil: 'networkidle2' });
      
      // Take screenshot after login
      if (this.config.debug) {
        await this.page.screenshot({ path: 'twitter-logged-in.png' });
      }
      
      // Verify login by checking for home timeline elements
      const successIndicators = [
        '[data-testid="primaryColumn"]',
        '[aria-label="Home timeline"]',
        '[aria-label="Timeline: Home"]',
        '[data-testid="SideNav_NewTweet_Button"]'
      ];
      
      let loginSuccessful = false;
      for (const selector of successIndicators) {
        try {
          const element = await this.page.$(selector);
          if (element) {
            loginSuccessful = true;
            this.logger.debug(`Login successful, found element: ${selector}`);
            break;
          }
        } catch (e) {
          // Continue trying other selectors
        }
      }
      
      if (!loginSuccessful) {
        this.logger.warn('Could not verify successful login by finding timeline elements');
        // Check if we're still on a login-related page
        const currentUrl = this.page.url();
        if (currentUrl.includes('login') || currentUrl.includes('signin')) {
          throw new Error('Login failed - still on login page');
        } else {
          this.logger.info('Proceeding anyway as we navigated away from login page');
        }
      }
      
      // Navigate to home to ensure we're on the right page
      await this.page.goto('https://twitter.com/home', { waitUntil: 'networkidle2' });
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      this.logger.info('Successfully logged in to Twitter');
    } catch (error) {
      this.logger.error('Error during Twitter login', error);
      // Take screenshot of error state
      if (this.page && this.config.debug) {
        await this.page.screenshot({ path: 'twitter-login-error.png' });
      }
      throw new Error(`Twitter login failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Disconnects from Twitter
   * 
   * @returns Promise resolving when disconnected
   */
  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }
    
    this.logger.info('Disconnecting from Twitter');
    
    try {
      // Stop monitoring
      if (this.monitorInterval) {
        clearInterval(this.monitorInterval);
        this.monitorInterval = null;
      }
      
      // Close browser if open
      if (this.browser) {
        this.logger.debug('Closing browser');
        await this.browser.close().catch((e: Error) => this.logger.error('Error closing browser', e));
        this.browser = null;
        this.page = null;
      }
      
      this.connected = false;
      this.logger.info('Disconnected from Twitter');
    } catch (error) {
      this.logger.error('Failed to disconnect from Twitter', error);
      throw error;
    }
  }
  
  /**
   * Posts a tweet to Twitter using browser automation
   * 
   * @param content - The content of the tweet
   * @param replyToId - Optional tweet ID to reply to
   * @returns Promise resolving to a tweet ID or confirmation string
   */
  async tweet(content: string, replyToId?: string): Promise<string> {
    if (!this.connected || !this.page || !this.browser) {
      throw new Error('Not connected to Twitter');
    }
    
    this.logger.debug('Posting tweet', { 
      content: content.substring(0, 30) + (content.length > 30 ? '...' : ''),
      replyToId
    });
    
    try {
      // Default tweet ID response when we can't get the actual ID
      let tweetId = `tweet_posted_${Date.now()}`;
      
      // Handle reply differently
      if (replyToId) {
        await this.postReplyWithBrowser(content, replyToId);
        this.logger.info('Reply posted successfully');
        return `reply_to_${replyToId}_posted`;
      }
      
      // Post a new tweet
      await this.postTweetWithBrowser(content);
      this.logger.info('Tweet posted successfully');
      
      // Take success screenshot
      if (this.config.debug && this.page) {
        await this.page.screenshot({ path: 'twitter-tweet-success.png' });
      }
      
      return tweetId;
    } catch (error) {
      this.logger.error('Error posting tweet', error);
      if (this.page && this.config.debug) {
        await this.page.screenshot({ path: 'twitter-tweet-error.png' });
      }
      throw error;
    }
  }

  /**
   * Posts a tweet using browser automation
   * 
   * @param content - The content of the tweet
   */
  private async postTweetWithBrowser(content: string): Promise<void> {
    if (!this.page) {
      throw new Error('Browser not initialized');
    }
    
    this.logger.debug('Posting new tweet using browser automation');
    
    try {
      // Navigate to home page
      await this.page.goto('https://twitter.com/home', { waitUntil: 'networkidle2' });
      
      // Wait for page to stabilize
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Take screenshot to see current page
      if (this.config.debug) {
        await this.page.screenshot({ path: 'twitter-home-before-tweet.png' });
      }
      
      // First try to find and click the compose button if needed
      const composeSelectors = [
        '[data-testid="SideNav_NewTweet_Button"]',
        '[aria-label="Tweet"]',
        '[aria-label="Post"]',
        'a[href="/compose/tweet"]'
      ];
      
      let composeClicked = false;
      for (const selector of composeSelectors) {
        try {
          const button = await this.page.$(selector);
          if (button) {
            this.logger.debug(`Found compose button with selector: ${selector}`);
            await button.click();
            this.logger.debug('Clicked compose button');
            await new Promise(resolve => setTimeout(resolve, 1500));
            composeClicked = true;
            break;
          }
        } catch (e) {
          this.logger.debug(`Selector ${selector} not found or could not be clicked`);
        }
      }
      
      // Try multiple selectors for the tweet textarea
      const textareaSelectors = [
        '[data-testid="tweetTextarea_0"]',
        '[aria-label="Tweet text"]',
        '[aria-label="Post text"]',
        '[role="textbox"]'
      ];
      
      let composerFound = false;
      let textareaElement = null;
      
      for (const selector of textareaSelectors) {
        try {
          this.logger.debug(`Looking for text area with selector: ${selector}`);
          textareaElement = await this.page.$(selector);
          if (textareaElement) {
            this.logger.debug(`Found text area with selector: ${selector}`);
            await textareaElement.click();
            await new Promise(resolve => setTimeout(resolve, 1000));
            await textareaElement.type(content);
            // Add a delay after typing to ensure the tweet button becomes enabled
            await new Promise(resolve => setTimeout(resolve, 2000));
            this.logger.debug('Entered tweet content');
            composerFound = true;
            break;
          }
        } catch (e) {
          this.logger.debug(`Could not use selector ${selector}`, e);
        }
      }
      
      // If we couldn't find the tweet textarea, try looking for "What's happening?"
      if (!composerFound) {
        this.logger.debug('Looking for "What\'s happening?" text');
        
        try {
          // Get all div elements
          const divs = await this.page.$$('div');
          
          // Look for one containing "What's happening?"
          for (const div of divs) {
            const text = await this.page.evaluate(el => el.textContent, div);
            
            if (text && (
                text.includes("What's happening?") || 
                text.includes("What is happening?") ||
                text.includes("What's on your mind?")
              )) {
              this.logger.debug('Found "What\'s happening?" text, clicking it');
              await div.click();
              await new Promise(resolve => setTimeout(resolve, 1000));
              
              // Type directly with keyboard
              await this.page.keyboard.type(content);
              // Add a delay after typing to ensure the tweet button becomes enabled
              await new Promise(resolve => setTimeout(resolve, 2000));
              this.logger.debug('Entered tweet content via keyboard');
              composerFound = true;
              break;
            }
          }
        } catch (e) {
          this.logger.debug('Error looking for "What\'s happening?" text', e);
        }
      }
      
      // If we still couldn't find the composer, try direct navigation
      if (!composerFound) {
        this.logger.debug('Trying direct navigation to compose page');
        await this.page.goto('https://twitter.com/compose/tweet', { waitUntil: 'networkidle2' });
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Take a screenshot of the compose page
        if (this.config.debug) {
          await this.page.screenshot({ path: 'twitter-compose-direct.png' });
        }
        
        // Try again with the text area selectors
        for (const selector of textareaSelectors) {
          try {
            textareaElement = await this.page.$(selector);
            if (textareaElement) {
              this.logger.debug(`Found text area with selector: ${selector}`);
              await textareaElement.click();
              await new Promise(resolve => setTimeout(resolve, 1000));
              await textareaElement.type(content);
              this.logger.debug('Entered tweet content after direct navigation');
              composerFound = true;
              break;
            }
          } catch (e) {
            this.logger.debug(`Could not use selector ${selector} after direct navigation`, e);
          }
        }
      }
      
      // If we still couldn't find the composer, give up
      if (!composerFound) {
        // Take screenshot to debug
        if (this.config.debug) {
          await this.page.screenshot({ path: 'twitter-composer-not-found.png' });
        }
        throw new Error('Could not find or use the tweet composer');
      }
      
      // Take screenshot of the composed tweet
      if (this.config.debug) {
        await this.page.screenshot({ path: 'twitter-composed-tweet.png' });
      }
      
      // Now find and click the tweet/post button
      const tweetButtonSelectors = [
        '[data-testid="tweetButtonInline"]',
        'div[data-testid="tweetButton"]',
        'button[data-testid="tweetButton"]',
        '[aria-label="Tweet"]',
        '[aria-label="Post"]',
        'div[role="button"]:has-text("Tweet")',
        'div[role="button"]:has-text("Post")',
        'button:enabled:has-text("Post")',
        'button:enabled:has-text("Tweet")'
      ];
      
      let tweetButtonClicked = false;
      
      // First try with specific selectors
      for (const selector of tweetButtonSelectors) {
        try {
          this.logger.debug(`Looking for tweet button with selector: ${selector}`);
          const button = await this.page.$(selector);
          
          if (button) {
            this.logger.debug(`Found tweet button with selector: ${selector}`);
            
            // Check if the button is disabled
            const isDisabled = await this.page.evaluate(el => {
              return el.getAttribute('aria-disabled') === 'true' || 
                    (el instanceof HTMLButtonElement && el.disabled === true) || 
                    el.classList.contains('disabled');
            }, button);
            
            if (isDisabled) {
              this.logger.debug('Tweet button is disabled, cannot click');
              continue;
            }
            
            // Click the button
            await button.click();
            this.logger.debug('Clicked tweet button');
            tweetButtonClicked = true;
            break;
          }
        } catch (e) {
          this.logger.debug(`Error with tweet button selector ${selector}`, e);
        }
      }
      
      // If we couldn't find a specific tweet button, try looking for buttons with text
      if (!tweetButtonClicked) {
        this.logger.debug('Looking for any button with text "Tweet" or "Post"');
        
        try {
          // Get all buttons or elements that might be buttons
          const buttons = await this.page.$$('button, div[role="button"]');
          
          for (const button of buttons) {
            try {
              const text = await this.page.evaluate(el => el.textContent, button);
              
              if (text && (text.includes('Tweet') || text.includes('Post'))) {
                this.logger.debug(`Found button with text: ${text}`);
                
                // Check if the button is disabled
                const isDisabled = await this.page.evaluate(el => {
                  return el.getAttribute('aria-disabled') === 'true' || 
                        (el instanceof HTMLButtonElement && el.disabled === true) || 
                        el.classList.contains('disabled');
                }, button);
                
                if (isDisabled) {
                  this.logger.debug('Button is disabled, cannot click');
                  continue;
                }
                
                await button.click();
                this.logger.debug('Clicked button by text');
                tweetButtonClicked = true;
                break;
              }
            } catch (buttonError) {
              // Continue to next button
            }
          }
        } catch (e) {
          this.logger.debug('Error looking for buttons by text', e);
        }
      }
      
      // If we still couldn't click the tweet button, try one more approach - 
      // evaluate all buttons on the page and find one with "Tweet" or "Post" text
      if (!tweetButtonClicked) {
        this.logger.debug('Trying to find any button that looks like a tweet button');
        try {
          const tweetButtonFound = await this.page.evaluate(() => {
            // Look for any button-like element containing 'Tweet' or 'Post'
            const possibleButtons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"]'));
            
            for (const button of possibleButtons) {
              const text = button.textContent || '';
              const isDisabled = (button as HTMLElement).hasAttribute('disabled') || 
                               button.getAttribute('aria-disabled') === 'true' || 
                               button.classList.contains('disabled');
              
              if ((text.includes('Tweet') || text.includes('Post')) && !isDisabled) {
                // Click the button
                (button as HTMLElement).click();
                return true;
              }
            }
            return false;
          });
          
          if (tweetButtonFound) {
            this.logger.debug('Found and clicked tweet button via direct DOM evaluation');
            tweetButtonClicked = true;
          }
        } catch (e) {
          this.logger.debug('Error finding tweet button via direct DOM evaluation', e);
        }
      }
      
      // If we still couldn't click the tweet button, try pressing Enter key
      if (!tweetButtonClicked) {
        this.logger.debug('Could not find tweet button, trying Enter key');
        await this.page.keyboard.press('Enter');
        tweetButtonClicked = true;
      }
      
      // Wait for the tweet to be posted
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Take a final screenshot
      if (this.config.debug) {
        await this.page.screenshot({ path: 'twitter-after-posting.png' });
      }
      
      this.logger.info('Tweet posting completed');
    } catch (error) {
      this.logger.error('Error posting tweet with browser', error);
      throw error;
    }
  }

  /**
   * Posts a reply to a tweet using browser automation
   * 
   * @param content - The content of the reply
   * @param tweetId - The ID of the tweet to reply to
   */
  private async postReplyWithBrowser(content: string, tweetId: string): Promise<void> {
    if (!this.page) {
      throw new Error('Browser not initialized');
    }
    
    this.logger.debug(`Posting reply to tweet ${tweetId}`);
    
    try {
      // Navigate to the tweet page
      await this.page.goto(`https://twitter.com/i/status/${tweetId}`, { waitUntil: 'networkidle2' });
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Take screenshot of tweet page
      if (this.config.debug) {
        await this.page.screenshot({ path: 'twitter-reply-page.png' });
      }
      
      // Find and click the reply button
      const replyButtonSelectors = [
        '[data-testid="reply"]',
        '[aria-label="Reply"]',
        'div[role="button"][data-testid="reply"]'
      ];
      
      let replyButtonClicked = false;
      
      for (const selector of replyButtonSelectors) {
        try {
          const replyButton = await this.page.$(selector);
          if (replyButton) {
            this.logger.debug(`Found reply button with selector: ${selector}`);
            await replyButton.click();
            this.logger.debug('Clicked reply button');
            await new Promise(resolve => setTimeout(resolve, 2000));
            replyButtonClicked = true;
            break;
          }
        } catch (e) {
          this.logger.debug(`Reply button selector ${selector} not found or error`, e);
        }
      }
      
      if (!replyButtonClicked) {
        throw new Error('Could not find or click reply button');
      }
      
      // Find the reply text area and enter the content
      const textareaSelectors = [
        '[data-testid="tweetTextarea_0"]',
        '[aria-label="Tweet text"]',
        '[aria-label="Reply text"]',
        '[role="textbox"]'
      ];
      
      let textareaFound = false;
      
      for (const selector of textareaSelectors) {
        try {
          const textarea = await this.page.$(selector);
          if (textarea) {
            this.logger.debug(`Found reply textarea with selector: ${selector}`);
            await textarea.click();
            await new Promise(resolve => setTimeout(resolve, 1000));
            await textarea.type(content);
            this.logger.debug('Entered reply content');
            textareaFound = true;
            break;
          }
        } catch (e) {
          this.logger.debug(`Reply textarea selector ${selector} not found or error`, e);
        }
      }
      
      if (!textareaFound) {
        // Try using keyboard directly
        this.logger.debug('Trying to enter reply text with keyboard');
        await this.page.keyboard.type(content);
        textareaFound = true;
      }
      
      if (!textareaFound) {
        throw new Error('Could not find or use reply textarea');
      }
      
      // Take screenshot of composed reply
      if (this.config.debug) {
        await this.page.screenshot({ path: 'twitter-reply-composed.png' });
      }
      
      // Find and click the reply/tweet button
      const replyTweetButtonSelectors = [
        '[data-testid="tweetButtonInline"]',
        '[data-testid="tweetButton"]',
        'div[role="button"]:has-text("Reply")',
        'div[role="button"]:has-text("Tweet")'
      ];
      
      let replyTweetButtonClicked = false;
      
      for (const selector of replyTweetButtonSelectors) {
        try {
          const button = await this.page.$(selector);
          if (button) {
            this.logger.debug(`Found reply tweet button with selector: ${selector}`);
            
            // Check if button is disabled
            const isDisabled = await this.page.evaluate(el => {
              return el.getAttribute('aria-disabled') === 'true' || 
                    (el instanceof HTMLButtonElement && el.disabled === true) || 
                    el.classList.contains('disabled');
            }, button);
            
            if (isDisabled) {
              this.logger.debug('Reply button is disabled, cannot click');
              continue;
            }
            
            await button.click();
            this.logger.debug('Clicked reply tweet button');
            replyTweetButtonClicked = true;
            break;
          }
        } catch (e) {
          this.logger.debug(`Reply tweet button selector ${selector} not found or error`, e);
        }
      }
      
      // If no specific button found, look for any button with Reply/Tweet text
      if (!replyTweetButtonClicked) {
        this.logger.debug('Looking for any button with Reply/Tweet text');
        
        try {
          const buttons = await this.page.$$('button, div[role="button"]');
          
          for (const button of buttons) {
            try {
              const text = await this.page.evaluate(el => el.textContent, button);
              
              if (text && (text.includes('Reply') || text.includes('Tweet'))) {
                this.logger.debug(`Found button with text: ${text}`);
                await button.click();
                this.logger.debug('Clicked button by text');
                replyTweetButtonClicked = true;
                break;
              }
            } catch (buttonError) {
              // Continue to next button
            }
          }
        } catch (e) {
          this.logger.debug('Error looking for buttons by text', e);
        }
      }
      
      // If still couldn't click the button, try Enter key
      if (!replyTweetButtonClicked) {
        this.logger.debug('Could not find reply tweet button, trying Enter key');
        await this.page.keyboard.press('Enter');
        replyTweetButtonClicked = true;
      }
      
      // Wait for the reply to be posted
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Take a final screenshot
      if (this.config.debug) {
        await this.page.screenshot({ path: 'twitter-after-reply.png' });
      }
      
      this.logger.info('Reply posting completed');
    } catch (error) {
      this.logger.error('Error posting reply with browser', error);
      throw error;
    }
  }

  /**
   * Sets up monitoring for tweets
   */
  private setupMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }
    
    const pollInterval = this.config.pollInterval || 60000;
    this.logger.info('Setting up tweet monitoring', { 
      keywords: this.config.monitorKeywords,
      users: this.config.monitorUsers,
      pollInterval
    });
    
    this.monitorInterval = setInterval(() => {
      this.checkForTweets();
    }, pollInterval);
  }
  
  /**
   * Checks for tweets that match monitoring criteria
   */
  private async checkForTweets(): Promise<void> {
    try {
      // This would be implemented with browser automation,
      // but for the basic implementation, we'll just log that it's not fully implemented
      this.logger.debug('Tweet monitoring is limited in browser-only implementation');
      
      // For a complete implementation, you would:
      // 1. Navigate to Twitter search pages for your monitored keywords
      // 2. Extract tweet data from the DOM
      // 3. Navigate to user profiles for monitored users
      // 4. Extract their latest tweets
      // 5. Process and emit events for matching tweets
    } catch (error) {
      this.logger.error('Error checking for tweets', error);
    }
  }
  
  /**
   * Likes a tweet (not fully implemented)
   * 
   * @param tweetId - The ID of the tweet to like
   */
  async like(tweetId: string): Promise<void> {
    this.logger.warn('Like functionality not fully implemented in browser-only version');
    // Would be implemented using browser automation to find and click the like button
  }
  
  /**
   * Retweets a tweet (not fully implemented)
   * 
   * @param tweetId - The ID of the tweet to retweet
   */
  async retweet(tweetId: string): Promise<void> {
    this.logger.warn('Retweet functionality not fully implemented in browser-only version');
    // Would be implemented using browser automation to find and click the retweet button
  }
  
  /**
   * Follows a user (not fully implemented)
   * 
   * @param username - The username of the user to follow
   */
  async follow(username: string): Promise<void> {
    this.logger.warn('Follow functionality not fully implemented in browser-only version');
    // Would be implemented using browser automation to navigate to the user's profile and click follow
  }
}