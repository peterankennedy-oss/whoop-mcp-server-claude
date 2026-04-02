import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { WhoopApiClient } from './whoop-api.js';
import { WhoopApiConfig } from './types.js';
import http from 'http';

export class WhoopMcpServer {
  private server: Server;
  private whoopClient: WhoopApiClient;
  private config: WhoopApiConfig;
  private isAuthorized: boolean = false;

  constructor(config: WhoopApiConfig) {
    this.config = config;
    this.server = new Server({
      name: 'whoop-mcp-server',
      version: '1.0.0',
    });

    this.whoopClient = new WhoopApiClient(config);
    this.setupToolHandlers();
  }

  private startOAuthCallbackServer(): Promise<string> {
    return new Promise((resolve, reject) => {
      const callbackServer = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url || '', `http://localhost:${process.env.MCP_SERVER_PORT || '3001'}`);
          if (url.pathname === '/oauth/callback') {
            const code = url.searchParams.get('code');
            if (code) {
              const tokenData = await this.whoopClient.exchangeCodeForToken(code);
              this.whoopClient.setAccessToken(tokenData.access_token);
              this.isAuthorized = true;
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end('<html><body><h1>WHOOP Authorization Successful!</h1><p>You can close this window and return to Claude.</p></body></html>');
              callbackServer.close();
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
      callbackServer.listen(port, () => {
        console.error(`OAuth callback server listening on port ${port}`);
      });

      setTimeout(() => {
        callbackServer.close();
        reject(new Error('OAuth callback timed out after 5 minutes'));
      }, 300000);
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
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
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
            const data = await this.whoopClient.getRecoveryCollection({
              start: args?.startDate as string,
              end: args?.endDate as string,
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            };
          }
          case 'get_sleep': {
            const data = await this.whoopClient.getSleepCollection({
              start: args?.startDate as string,
              end: args?.endDate as string,
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            };
          }
          case 'get_workouts': {
            const data = await this.whoopClient.getWorkoutCollection({
              start: args?.startDate as string,
              end: args?.endDate as string,
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            };
          }
          case 'get_cycles': {
            const data = await this.whoopClient.getCycleCollection({
              start: args?.startDate as string,
              end: args?.endDate as string,
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