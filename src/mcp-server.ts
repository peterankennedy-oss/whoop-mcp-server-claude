import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { WhoopApiClient } from './whoop-api.js';
import { WhoopApiConfig } from './types.js';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TOKEN_FILE = path.join(__dirname, '..', 'whoop-tokens.json');

export class WhoopMcpServer {
  private server: Server;
  private whoopClient: WhoopApiClient;
  private config: WhoopApiConfig;
  private isAuthorized: boolean = false;
  private callbackServer: http.Server | null = null;
  private tokenRefreshPromise: Promise<void> | null = null;

  constructor(config: WhoopApiConfig) {
    this.config = config;
    this.server = new Server({
      name: 'whoop-mcp-server',
      version: '1.0.0',
    });

    this.whoopClient = new WhoopApiClient(config);

    // Auto-save tokens when the API client refreshes mid-session
    this.whoopClient.setOnTokenRefresh((accessToken, refreshToken, expiresIn) => {
      console.error('Token auto-refreshed mid-session, saving to disk...');
      this.isAuthorized = true;
      this.saveTokens(accessToken, refreshToken, expiresIn);
    });

    this.tokenRefreshPromise = this.loadTokens();
    this.setupToolHandlers();
  }

  private toISOStart(date: string): string {
    if (date.includes('T')) return date;
    return `${date}T00:00:00.000Z`;
  }

  private toISOEnd(date: string): string {
    if (date.includes('T')) return date;
    return `${date}T23:59:59.999Z`;
  }

  private saveTokens(accessToken: string, refreshToken: string, expiresIn: number): void {
    const data = {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      timestamp: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
      console.error('Tokens saved to', TOKEN_FILE);
    } catch (err) {
      console.error('Failed to save tokens:', err);
    }
  }

  private async loadTokens(): Promise<void> {
    try {
      if (!fs.existsSync(TOKEN_FILE)) return;

      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      if (!data.accessToken) return;

      // Refresh if expired OR expiring within 5 minutes (buffer to avoid mid-call expiry)
      const isExpired = data.expiresAt && Date.now() > (data.expiresAt - 5 * 60 * 1000);

      if (isExpired && data.refreshToken) {
        console.error('Access token expired, refreshing...');
        try {
          const tokenData = await this.whoopClient.refreshToken(data.refreshToken);
          this.whoopClient.setAccessToken(tokenData.access_token);
          this.isAuthorized = true;
          // Fall back to existing refresh token if the server didn't return a new one
          const newRefreshToken = tokenData.refresh_token || data.refreshToken;
          this.whoopClient.setRefreshToken(newRefreshToken);
          this.saveTokens(tokenData.access_token, newRefreshToken, tokenData.expires_in);
          console.error('Token refreshed successfully');
        } catch (err) {
          console.error('Token refresh failed, re-authorization needed:', err);
          this.isAuthorized = false;
        }
      } else if (isExpired) {
        console.error('Access token expired and no refresh token available. Re-authorization needed.');
        this.isAuthorized = false;
      } else {
        this.whoopClient.setAccessToken(data.accessToken);
        if (data.refreshToken) {
          this.whoopClient.setRefreshToken(data.refreshToken);
        }
        this.isAuthorized = true;
        console.error('Loaded saved tokens from', TOKEN_FILE);
      }
    } catch (err) {
      console.error('Failed to load tokens:', err);
    }
  }

  private startOAuthCallbackServer(): Promise<string> {
    if (this.callbackServer) {
      this.callbackServer.close();
      this.callbackServer = null;
    }

    return new Promise((resolve, reject) => {
      this.callbackServer = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url || '', `http://localhost:${process.env.MCP_SERVER_PORT || '3001'}`);
          if (url.pathname === '/oauth/callback') {
            const error = url.searchParams.get('error');
            if (error) {
              const desc = url.searchParams.get('error_description') || 'Unknown error';
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(`<html><body><h1>Authorization Error</h1><p>${error}: ${desc}</p></body></html>`);
              return;
            }

            const code = url.searchParams.get('code');
            if (code) {
              const tokenData = await this.whoopClient.exchangeCodeForToken(code);
              this.whoopClient.setAccessToken(tokenData.access_token);
              this.whoopClient.setRefreshToken(tokenData.refresh_token);
              this.isAuthorized = true;
              this.saveTokens(tokenData.access_token, tokenData.refresh_token, tokenData.expires_in);
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end('<html><body><h1>WHOOP Authorization Successful!</h1><p>You can close this window and return to Claude.</p></body></html>');
              this.callbackServer?.close();
              this.callbackServer = null;
              resolve(tokenData.access_token);
            } else {
              res.writeHead(400, { 'Content-Type': 'text/html' });
              res.end('<html><body><h1>Error: No authorization code received</h1></body></html>');
            }
          }
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`<html><body><h1>Error during authorization</h1><p>${error}</p></body></html>`);
          reject(error);
        }
      });

      const port = parseInt(process.env.MCP_SERVER_PORT || '3001');

      this.callbackServer.on('error', (err: NodeJS.ErrnoException) => {
        console.error(`Callback server error: ${err.message}`);
        if (err.code === 'EADDRINUSE') {
          console.error(`Port ${port} in use, retrying in 1s...`);
          this.callbackServer?.close();
          setTimeout(() => {
            this.callbackServer?.listen(port, '0.0.0.0');
          }, 1000);
        }
      });

      this.callbackServer.listen(port, '0.0.0.0', () => {
        console.error(`OAuth callback server listening on port ${port}`);
      });

      setTimeout(() => {
        this.callbackServer?.close();
        this.callbackServer = null;
        reject(new Error('OAuth callback timed out after 10 minutes'));
      }, 600000);
    });
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'authorize_whoop',
          description: 'Start the WHOOP OAuth authorization flow. Returns a URL that the user must open in their browser to authorize access to their WHOOP data.',
          inputSchema: {
            type: 'object' as const,
            properties: {},
          },
        },
        {
          name: 'get_recovery',
          description: 'Get WHOOP recovery data for a date range. Returns recovery score, HRV, resting heart rate, and other metrics. User must authorize first using authorize_whoop.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              startDate: {
                type: 'string',
                description: 'Start date in YYYY-MM-DD format',
              },
              endDate: {
                type: 'string',
                description: 'End date in YYYY-MM-DD format',
              },
            },
          },
        },
        {
          name: 'get_sleep',
          description: 'Get WHOOP sleep data for a date range. Returns sleep stages, duration, efficiency, and other sleep metrics.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              startDate: {
                type: 'string',
                description: 'Start date in YYYY-MM-DD format',
              },
              endDate: {
                type: 'string',
                description: 'End date in YYYY-MM-DD format',
              },
            },
          },
        },
        {
          name: 'get_workouts',
          description: 'Get WHOOP workout data for a date range. Returns workout type, strain, heart rate zones, and other workout metrics.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              startDate: {
                type: 'string',
                description: 'Start date in YYYY-MM-DD format',
              },
              endDate: {
                type: 'string',
                description: 'End date in YYYY-MM-DD format',
              },
            },
          },
        },
        {
          name: 'get_cycles',
          description: 'Get WHOOP cycle (strain) data for a date range. Returns daily strain scores and related metrics.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              startDate: {
                type: 'string',
                description: 'Start date in YYYY-MM-DD format',
              },
              endDate: {
                type: 'string',
                description: 'End date in YYYY-MM-DD format',
              },
            },
          },
        },
        {
          name: 'get_profile',
          description: 'Get the WHOOP user profile information.',
          inputSchema: {
            type: 'object' as const,
            properties: {},
          },
        },
        {
          name: 'get_body_measurement',
          description: 'Get the latest WHOOP body measurement data.',
          inputSchema: {
            type: 'object' as const,
            properties: {},
          },
        },
        {
          name: 'exchange_code',
          description: 'Manually exchange an OAuth authorization code for an access token. Use this if the automatic callback failed. The code can be found in the browser URL bar after authorizing.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              code: {
                type: 'string',
                description: 'The authorization code from the OAuth callback URL (the value after ?code= in the URL)',
              },
            },
            required: ['code'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        if (name === 'exchange_code') {
          const code = args?.code as string;
          if (!code) {
            return {
              content: [{ type: 'text', text: 'Error: code parameter is required' }],
              isError: true,
            };
          }
          const tokenData = await this.whoopClient.exchangeCodeForToken(code);
          this.whoopClient.setAccessToken(tokenData.access_token);
          this.whoopClient.setRefreshToken(tokenData.refresh_token);
          this.isAuthorized = true;
          this.saveTokens(tokenData.access_token, tokenData.refresh_token, tokenData.expires_in);
          return {
            content: [{ type: 'text', text: 'Authorization successful! You can now use the WHOOP data tools.' }],
          };
        }

        if (name === 'authorize_whoop') {
          const state = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
          const authUrl = this.whoopClient.getAuthorizationUrl(state);
          const callbackPromise = this.startOAuthCallbackServer();
          callbackPromise.then(() => {
            console.error('WHOOP authorization completed successfully');
          }).catch((err) => {
            console.error('WHOOP authorization failed:', err);
          });
          return {
            content: [{
              type: 'text',
              text: `Please open this URL in your browser to authorize WHOOP access:\n\n${authUrl}\n\nAfter authorizing, you will be redirected back and can start using the other WHOOP tools.`,
            }],
          };
        }

        // Wait for any pending token refresh before checking auth
        if (this.tokenRefreshPromise) {
          await this.tokenRefreshPromise;
          this.tokenRefreshPromise = null;
        }

        if (!this.isAuthorized) {
          return {
            content: [{
              type: 'text',
              text: 'Not authorized yet. Please use the authorize_whoop tool first to connect your WHOOP account.',
            }],
            isError: true,
          };
        }

        switch (name) {
          case 'get_recovery': {
            const startDate = args?.startDate as string;
            const endDate = args?.endDate as string;
            const data = await this.whoopClient.getRecoveryCollection({
              start: startDate ? this.toISOStart(startDate) : undefined,
              end: endDate ? this.toISOEnd(endDate) : undefined,
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            };
          }
          case 'get_sleep': {
            const startDate = args?.startDate as string;
            const endDate = args?.endDate as string;
            const data = await this.whoopClient.getSleepCollection({
              start: startDate ? this.toISOStart(startDate) : undefined,
              end: endDate ? this.toISOEnd(endDate) : undefined,
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            };
          }
          case 'get_workouts': {
            const startDate = args?.startDate as string;
            const endDate = args?.endDate as string;
            const data = await this.whoopClient.getWorkoutCollection({
              start: startDate ? this.toISOStart(startDate) : undefined,
              end: endDate ? this.toISOEnd(endDate) : undefined,
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            };
          }
          case 'get_cycles': {
            const startDate = args?.startDate as string;
            const endDate = args?.endDate as string;
            const data = await this.whoopClient.getCycleCollection({
              start: startDate ? this.toISOStart(startDate) : undefined,
              end: endDate ? this.toISOEnd(endDate) : undefined,
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            };
          }
          case 'get_profile': {
            const data = await this.whoopClient.getUserProfile();
            return {
              content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            };
          }
          case 'get_body_measurement': {
            const data = await this.whoopClient.getUserBodyMeasurements();
            return {
              content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            };
          }
          default:
            return {
              content: [{ type: 'text', text: `Unknown tool: ${name}` }],
              isError: true,
            };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('WHOOP MCP Server running on stdio');
  }
}