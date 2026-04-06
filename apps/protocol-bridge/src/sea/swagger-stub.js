/**
 * Stub module that replaces @nestjs/swagger in SEA builds.
 *
 * All Swagger decorators become no-op identity functions,
 * so controllers compile without errors but produce no docs.
 */

// No-op decorator factory: returns a decorator that does nothing
const noop = () => (_target, _key, descriptor) => descriptor || _target
const noopClass = () => (target) => target

// Common Swagger decorator exports (all no-ops)
module.exports = {
  // Class decorators
  ApiTags: noopClass,
  ApiBearerAuth: noopClass,
  ApiSecurity: noopClass,
  ApiExcludeController: noopClass,

  // Method decorators
  ApiOperation: noop,
  ApiResponse: noop,
  ApiOkResponse: noop,
  ApiCreatedResponse: noop,
  ApiBadRequestResponse: noop,
  ApiUnauthorizedResponse: noop,
  ApiForbiddenResponse: noop,
  ApiNotFoundResponse: noop,
  ApiConflictResponse: noop,
  ApiInternalServerErrorResponse: noop,
  ApiProduces: noop,
  ApiConsumes: noop,
  ApiBody: noop,
  ApiQuery: noop,
  ApiParam: noop,
  ApiHeader: noop,
  ApiExcludeEndpoint: noop,

  // Property decorators
  ApiProperty: noop,
  ApiPropertyOptional: noop,
  ApiHideProperty: noop,

  // Swagger setup (no-op in SEA)
  DocumentBuilder: class {
    setTitle() {
      return this
    }
    setDescription() {
      return this
    }
    setVersion() {
      return this
    }
    addApiKey() {
      return this
    }
    addBearerAuth() {
      return this
    }
    addTag() {
      return this
    }
    build() {
      return {}
    }
  },
  SwaggerModule: {
    createDocument: () => ({}),
    setup: () => {},
  },
}
