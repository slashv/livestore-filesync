declare module "aws4fetch" {
  export interface AwsClientInit {
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
    region?: string
    service?: string
  }

  export class AwsClient {
    constructor(init: AwsClientInit)

    sign(
      input: string | URL | Request,
      init?: RequestInit & { aws?: Record<string, unknown> }
    ): Promise<Request>
  }
}
