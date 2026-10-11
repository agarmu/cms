// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

export type ErrorCode = "conflict" | "not_found" | "forbidden";

/** Expected application failures whose messages are safe to show to callers. */
export class AppError extends Error {
    constructor(
        readonly code: ErrorCode,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = new.target.name;
    }
}

export class ConflictError extends AppError {
    constructor(message: string, options?: ErrorOptions) {
        super("conflict", message, options);
    }
}

export class NotFoundError extends AppError {
    constructor(message: string, options?: ErrorOptions) {
        super("not_found", message, options);
    }
}

export class ForbiddenError extends AppError {
    constructor(message: string) {
        super("forbidden", message);
    }
}
