import type { ContractBundleInput } from './types'

export function sampleBundles(): { baseline: ContractBundleInput; candidate: ContractBundleInput } {
  const entry = (version: string, webhook: boolean) => `openapi: ${version}
info: { title: Order Service, version: '${webhook ? '2' : '1'}' }
paths:
  /orders/{id}:
    get:
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        '200':
          description: Order details
          content:
            application/json:
              schema:
                $ref: './schemas/order.yaml'
${webhook ? `webhooks:
  orderUpdated:
    post:
      requestBody:
        content:
          application/json:
            schema: { $ref: './schemas/order.yaml' }
      responses:
        '200': { description: Notification accepted }
` : ''}`
  const schema = (candidate: boolean) => `type: object
required: [id, status]
additionalProperties: false
properties:
  id: { type: ${candidate ? 'integer' : 'string'} }
  status: { type: string, enum: [open, closed${candidate ? ', archived' : ''}] }
  note: ${candidate ? '{ type: [string, "null"] }' : '{ type: string, nullable: true }'}
`
  return {
    baseline: { kind: 'bundle', entry: 'openapi.yaml', files: [{ path: 'openapi.yaml', content: entry('3.0.4', false) }, { path: 'schemas/order.yaml', content: schema(false) }] },
    candidate: { kind: 'bundle', entry: 'openapi.yaml', files: [{ path: 'openapi.yaml', content: entry('3.1.0', true) }, { path: 'schemas/order.yaml', content: schema(true) }] },
  }
}

export const sampleBaseline = `openapi: 3.0.3
info:
  title: Campus Events API
  version: 1.4.0
paths:
  /events:
    get:
      operationId: listEvents
      parameters:
        - in: query
          name: category
          required: false
          schema:
            type: string
            enum: [academic, social, sports]
      responses:
        '200':
          description: Events found
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Event'
    post:
      operationId: createEvent
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateEvent'
      responses:
        '201':
          description: Created
  /events/{eventId}:
    get:
      operationId: getEvent
      parameters:
        - in: path
          name: eventId
          required: true
          schema: { type: string }
      responses:
        '200':
          description: Event
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Event'
components:
  schemas:
    CreateEvent:
      type: object
      required: [title, startsAt]
      properties:
        title: { type: string }
        startsAt: { type: string, format: date-time }
        venue: { type: string }
    Event:
      type: object
      required: [id, title, startsAt, status]
      properties:
        id: { type: string }
        title: { type: string }
        startsAt: { type: string, format: date-time }
        status:
          type: string
          enum: [draft, published, cancelled]
        venue: { type: string }
`

export const sampleCandidate = `openapi: 3.1.0
info:
  title: Campus Events API
  version: 2.0.0
paths:
  /events:
    get:
      operationId: searchEvents
      parameters:
        - in: query
          name: category
          required: true
          schema:
            type: string
            enum: [academic, social]
      responses:
        '200':
          description: Events found
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Event'
    post:
      operationId: createEvent
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateEvent'
      responses:
        '202':
          description: Accepted
components:
  schemas:
    CreateEvent:
      type: object
      required: [title, startsAt, organizerId]
      properties:
        title: { type: string, minLength: 3 }
        startsAt: { type: string, format: date-time }
        organizerId: { type: string }
    Event:
      type: object
      required: [id, title, startsAt, status]
      properties:
        id: { type: string }
        title: { type: string }
        startsAt: { type: string, format: date-time }
        status:
          type: string
          enum: [draft, published, postponed, cancelled]
`
