import isReference, { type NodeWithFieldDefinition } from 'is-reference';
import type MagicString from 'magic-string';
import type { NormalizedTreeshakingOptions } from '../../rollup/types';
import { BLANK } from '../../utils/blank';
import { errorIllegalImportReassignment } from '../../utils/error';
import { PureFunctionKey } from '../../utils/pureFunctions';
import type { NodeRenderOptions, RenderOptions } from '../../utils/renderHelpers';
import type { DeoptimizableEntity } from '../DeoptimizableEntity';
import type { HasEffectsContext, InclusionContext } from '../ExecutionContext';
import type {
	NodeInteraction,
	NodeInteractionCalled,
	NodeInteractionWithThisArgument
} from '../NodeInteractions';
import {
	INTERACTION_ACCESSED,
	INTERACTION_ASSIGNED,
	INTERACTION_CALLED,
	NODE_INTERACTION_UNKNOWN_ACCESS
} from '../NodeInteractions';
import type FunctionScope from '../scopes/FunctionScope';
import { EMPTY_PATH, type ObjectPath, type PathTracker } from '../utils/PathTracker';
import GlobalVariable from '../variables/GlobalVariable';
import LocalVariable from '../variables/LocalVariable';
import type Variable from '../variables/Variable';
import * as NodeType from './NodeType';
import type SpreadElement from './SpreadElement';
import {
	type ExpressionEntity,
	type LiteralValueOrUnknown,
	UNKNOWN_EXPRESSION
} from './shared/Expression';
import { NodeBase } from './shared/Node';
import type { PatternNode } from './shared/Pattern';

export type IdentifierWithVariable = Identifier & { variable: Variable };

const tdzVariableKinds = {
	__proto__: null,
	class: true,
	const: true,
	let: true,
	var: true
};

export default class Identifier extends NodeBase implements PatternNode {
	declare name: string;
	declare type: NodeType.tIdentifier;
	variable: Variable | null = null;
	private isTDZAccess: boolean | null = null;

	addExportedVariables(
		variables: Variable[],
		exportNamesByVariable: ReadonlyMap<Variable, readonly string[]>
	): void {
		if (exportNamesByVariable.has(this.variable!)) {
			variables.push(this.variable!);
		}
	}

	bind(): void {
		if (!this.variable && isReference(this, this.parent as NodeWithFieldDefinition)) {
			this.variable = this.scope.findVariable(this.name);
			this.variable.addReference(this);
		}
	}

	declare(kind: string, init: ExpressionEntity): LocalVariable[] {
		let variable: LocalVariable;
		const { treeshake } = this.context.options;
		switch (kind) {
			case 'var': {
				variable = this.scope.addDeclaration(this, this.context, init, true);
				if (treeshake && treeshake.correctVarValueBeforeDeclaration) {
					// Necessary to make sure the init is deoptimized. We cannot call deoptimizePath here.
					variable.markInitializersForDeoptimization();
				}
				break;
			}
			case 'function': {
				// in strict mode, functions are only hoisted within a scope but not across block scopes
				variable = this.scope.addDeclaration(this, this.context, init, false);
				break;
			}
			case 'let':
			case 'const':
			case 'class': {
				variable = this.scope.addDeclaration(this, this.context, init, false);
				break;
			}
			case 'parameter': {
				variable = (this.scope as FunctionScope).addParameterDeclaration(this);
				break;
			}
			/* istanbul ignore next */
			default: {
				/* istanbul ignore next */
				throw new Error(`Internal Error: Unexpected identifier kind ${kind}.`);
			}
		}
		variable.kind = kind;
		return [(this.variable = variable)];
	}

	deoptimizePath(path: ObjectPath): void {
		if (path.length === 0 && !this.scope.contains(this.name)) {
			this.disallowImportReassignment();
		}
		// We keep conditional chaining because an unknown Node could have an
		// Identifier as property that might be deoptimized by default
		this.variable?.deoptimizePath(path);
	}

	deoptimizeThisOnInteractionAtPath(
		interaction: NodeInteractionWithThisArgument,
		path: ObjectPath,
		recursionTracker: PathTracker
	): void {
		this.variable!.deoptimizeThisOnInteractionAtPath(interaction, path, recursionTracker);
	}

	getLiteralValueAtPath(
		path: ObjectPath,
		recursionTracker: PathTracker,
		origin: DeoptimizableEntity
	): LiteralValueOrUnknown {
		return this.getVariableRespectingTDZ()!.getLiteralValueAtPath(path, recursionTracker, origin);
	}

	getReturnExpressionWhenCalledAtPath(
		path: ObjectPath,
		interaction: NodeInteractionCalled,
		recursionTracker: PathTracker,
		origin: DeoptimizableEntity
	): [expression: ExpressionEntity, isPure: boolean] {
		const [expression, isPure] =
			this.getVariableRespectingTDZ()!.getReturnExpressionWhenCalledAtPath(
				path,
				interaction,
				recursionTracker,
				origin
			);
		return [expression, isPure || this.isPureFunction(path)];
	}

	hasEffects(context: HasEffectsContext): boolean {
		if (!this.deoptimized) this.applyDeoptimizations();
		if (this.isPossibleTDZ() && this.variable!.kind !== 'var') {
			return true;
		}
		return (
			(this.context.options.treeshake as NormalizedTreeshakingOptions).unknownGlobalSideEffects &&
			this.variable instanceof GlobalVariable &&
			!this.isPureFunction(EMPTY_PATH) &&
			this.variable.hasEffectsOnInteractionAtPath(
				EMPTY_PATH,
				NODE_INTERACTION_UNKNOWN_ACCESS,
				context
			)
		);
	}

	hasEffectsOnInteractionAtPath(
		path: ObjectPath,
		interaction: NodeInteraction,
		context: HasEffectsContext
	): boolean {
		switch (interaction.type) {
			case INTERACTION_ACCESSED: {
				return (
					this.variable !== null &&
					!this.isPureFunction(path) &&
					this.getVariableRespectingTDZ()!.hasEffectsOnInteractionAtPath(path, interaction, context)
				);
			}
			case INTERACTION_ASSIGNED: {
				return (
					path.length > 0 ? this.getVariableRespectingTDZ() : this.variable
				)!.hasEffectsOnInteractionAtPath(path, interaction, context);
			}
			case INTERACTION_CALLED: {
				return (
					!this.isPureFunction(path) &&
					this.getVariableRespectingTDZ()!.hasEffectsOnInteractionAtPath(path, interaction, context)
				);
			}
		}
	}

	include(): void {
		if (!this.deoptimized) this.applyDeoptimizations();
		if (!this.included) {
			this.included = true;
			if (this.variable !== null) {
				this.context.includeVariableInModule(this.variable);
			}
		}
	}

	includeCallArguments(
		context: InclusionContext,
		parameters: readonly (ExpressionEntity | SpreadElement)[]
	): void {
		this.variable!.includeCallArguments(context, parameters);
	}

	isPossibleTDZ(): boolean {
		// return cached value to avoid issues with the next tree-shaking pass
		if (this.isTDZAccess !== null) return this.isTDZAccess;

		if (
			!(this.variable instanceof LocalVariable) ||
			!this.variable.kind ||
			!(this.variable.kind in tdzVariableKinds)
		) {
			return (this.isTDZAccess = false);
		}

		let decl_id;
		if (
			this.variable.declarations &&
			this.variable.declarations.length === 1 &&
			(decl_id = this.variable.declarations[0] as any) &&
			this.start < decl_id.start &&
			closestParentFunctionOrProgram(this) === closestParentFunctionOrProgram(decl_id)
		) {
			// a variable accessed before its declaration
			// in the same function or at top level of module
			return (this.isTDZAccess = true);
		}

		if (!this.variable.initReached) {
			// Either a const/let TDZ violation or
			// var use before declaration was encountered.
			return (this.isTDZAccess = true);
		}

		return (this.isTDZAccess = false);
	}

	markDeclarationReached(): void {
		this.variable!.initReached = true;
	}

	render(
		code: MagicString,
		{ snippets: { getPropertyAccess } }: RenderOptions,
		{ renderedParentType, isCalleeOfRenderedParent, isShorthandProperty }: NodeRenderOptions = BLANK
	): void {
		if (this.variable) {
			const name = this.variable.getName(getPropertyAccess);

			if (name !== this.name) {
				code.overwrite(this.start, this.end, name, {
					contentOnly: true,
					storeName: true
				});
				if (isShorthandProperty) {
					code.prependRight(this.start, `${this.name}: `);
				}
			}
			// In strict mode, any variable named "eval" must be the actual "eval" function
			if (
				name === 'eval' &&
				renderedParentType === NodeType.CallExpression &&
				isCalleeOfRenderedParent
			) {
				code.appendRight(this.start, '0, ');
			}
		}
	}

	protected applyDeoptimizations(): void {
		this.deoptimized = true;
		if (this.variable instanceof LocalVariable) {
			this.variable.consolidateInitializers();
			this.context.requestTreeshakingPass();
		}
	}

	private disallowImportReassignment(): never {
		return this.context.error(
			errorIllegalImportReassignment(this.name, this.context.module.id),
			this.start
		);
	}

	private getVariableRespectingTDZ(): ExpressionEntity | null {
		if (this.isPossibleTDZ()) {
			return UNKNOWN_EXPRESSION;
		}
		return this.variable;
	}

	private isPureFunction(path: ObjectPath) {
		let currentPureFunction = this.context.manualPureFunctions[this.name];
		for (const segment of path) {
			if (currentPureFunction) {
				if (currentPureFunction[PureFunctionKey]) {
					return true;
				}
				currentPureFunction = currentPureFunction[segment as string];
			} else {
				return false;
			}
		}
		return currentPureFunction?.[PureFunctionKey] as boolean;
	}
}

function closestParentFunctionOrProgram(node: any): any {
	while (node && !/^Program|Function/.test(node.type)) {
		node = node.parent;
	}
	// one of: ArrowFunctionExpression, FunctionDeclaration, FunctionExpression or Program
	return node;
}
