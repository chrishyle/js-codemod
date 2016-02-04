export default function(file, api) {
  const j = api.jscodeshift;

  const root = j(file.source);

  const TOP_LEVEL_TYPES = [
    'Function',
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
    'Program',
  ];
  const FOR_STATEMENTS = [
    'ForStatement',
    'ForOfStatement',
    'ForInStatement',
  ];
  const getScopeNode = blockScopeNode => {
    let scopeNode = blockScopeNode;
    let isInFor = FOR_STATEMENTS.indexOf(blockScopeNode.value.type) !== -1;
    while (TOP_LEVEL_TYPES.indexOf(scopeNode.node.type) === -1) {
      scopeNode = scopeNode.parentPath;
      isInFor = isInFor || FOR_STATEMENTS.indexOf(scopeNode.value.type) !== -1;
    }
    return {scopeNode, isInFor};
  };

  const isTruelyVar = (node, declarator) => {
    const blockScopeNode = node.parentPath;
    const {scopeNode, isInFor} = getScopeNode(blockScopeNode);


    // if we are in a for loop of some kind, and the variable
    // is referenced within a closure, rever to `var`
    // It would be safe to do the conversion if you can verify
    // that the callback is run synchronously
    const isUsedInClosure = (
      isInFor &&
      j(blockScopeNode).find(j.Function).filter(
        functionNode => (
          j(functionNode).find(j.Identifier).filter(
            id => id.value.name === declarator.id.name
          ).size() !== 0
        )
      ).size() !== 0
    );
    return isUsedInClosure || j(scopeNode)
      .find(j.Identifier)
      .filter(n => {
        if (declarator.id.name === n.value.name && getScopeNode(n.parent).scopeNode === scopeNode) {
          // if the variable is referenced outside the current block
          // scope, revert to using `var`
          const isOutsideCurrentScope = (
            j(blockScopeNode).find(j.Identifier).filter(
              innerNode => innerNode.node.start === n.node.start
            ).size() === 0
          );

          // if two attempts are made to declare the same variable,
          // revert to `var`
          // TODO: if they are in different block scopes, it may be
          //       safe to convert them anyway
          const isDeclaredTwice = (
            n.parent.value.type === 'VariableDeclarator' &&
            n.parent.value.id === n.value &&
            n.parent.value !== declarator
          );

          // if a variable is used before it is declared, rever to
          // `var`
          // TODO: If `isDeclaredTwice` is improved, and there is
          //       another declaration for this variable, it may be
          //       safe to convert this anyway
          const isUsedBeforeDeclaration = (
            n.value.start < declarator.start
          );

          return (
            isOutsideCurrentScope ||
            isDeclaredTwice ||
            isUsedBeforeDeclaration
          );
        }
      }).size() > 0;
  };

  /**
   * isMutated utility function to determine whether a VariableDeclaration
   * contains mutations. Takes an optional VariableDeclarator node argument to
   * return only whether that specific Identifier is mutated
   *
   * @param {ASTPath} node VariableDeclaration path
   * @param {ASTNode} [declarator] VariableDeclarator node
   * @return {Boolean}
   */
  const isMutated = (node, declarator) => {
    const scopeNode = node.parent;

    const hasAssignmentMutation = j(scopeNode)
      .find(j.AssignmentExpression)
      .filter(n => {
        if (declarator) {
          if (declarator.id.type === 'ObjectPattern') {
            return declarator.id.properties.some(d =>
              (d.type === 'SpreadProperty' ? d.argument.name : d.value.name) === n.value.left.name
            );
          } else if (declarator.id.type === 'ArrayPattern') {
            return declarator.id.elements.some(d =>
              (d.type === 'RestElement' ? d.argument.name : d.name) === n.value.left.name
            );
          }

          if (n.value.left.type === 'ObjectPattern') {
            return n.value.left.properties.some(p => p.key.name === declarator.id.name);
          } else if (n.value.left.type === 'ArrayPattern') {
            return n.value.left.elements.some(e =>
              (e.type === 'RestElement' ? e.argument.name : e.name) === declarator.id.name
            );
          }
          return declarator.id.name === n.value.left.name;
        }

        if (node.value.declarations.some(d => d.id.name === n.value.left.name)) {
          return true;
        }
      }).size() > 0;

    const hasUpdateMutation = j(scopeNode)
      .find(j.UpdateExpression)
      .filter(n => {
        if (declarator) {
          if (declarator.id.type === 'ObjectPattern') {
            return declarator.id.properties.some(d =>
              (d.type === 'SpreadProperty' ? d.argument.name : d.value.name) === n.value.argument.name
            );
          } else if (declarator.id.type === 'ArrayPattern') {
            return declarator.id.elements.some(
              e => (e.type === 'RestElement' ? e.argument.name : e.name) === n.value.argument.name
            );
          }

          return declarator.id.name === n.value.argument.name;
        }

        if (node.value.declarations.some(d => d.id.name === n.value.argument.name)) {
          return true;
        }
      }).size() > 0;

    return hasAssignmentMutation || hasUpdateMutation;
  };

  root.find(j.VariableDeclaration).filter(
    dec => dec.value.kind === 'var'
  ).filter(declaration => {
    return declaration.value.declarations.every(declarator => {
      return !isTruelyVar(declaration, declarator);
    });
  }).forEach(declaration => {
    if (
      declaration.value.declarations.some(declarator => {
        return !declarator.init || isMutated(declaration, declarator);
      })
    ) {
      declaration.value.kind = 'let';
    } else {
      declaration.value.kind = 'const';
    }
  });
  return root.toSource();
}
