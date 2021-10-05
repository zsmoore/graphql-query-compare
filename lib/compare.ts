import {
  DefinitionNode,
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  OperationDefinitionNode,
  parse,
  SelectionNode,
  SelectionSetNode,
  visit,
} from 'graphql';

function filterToOperations(arr: readonly DefinitionNode[]): OperationDefinitionNode[] {
  return arr.filter((el) => el.kind === 'OperationDefinition') as OperationDefinitionNode[];
}

function filterToQueries(arr: readonly OperationDefinitionNode[]) : OperationDefinitionNode[] {
  return arr.filter((el) => el.operation === 'query');
}

function getQuery(document: DocumentNode): OperationDefinitionNode | undefined {
  const queries = filterToQueries(filterToOperations(document.definitions));
  return queries[0];
}

function getFragmentDefinitions(document: DocumentNode): FragmentDefinitionNode[] {
  const fragmentDefinitions: FragmentDefinitionNode[] = [];
  visit(document, {
    FragmentDefinition(node) {
      fragmentDefinitions.push(node);
    },
  });
  return fragmentDefinitions;
}

function getSelectionSetsFromFragmentDefinitions(
  arr: readonly FragmentDefinitionNode[],
): Map<string, SelectionSetNode> {
  const fragmentNameToSelectionSet: Map<string, SelectionSetNode> = new Map();
  arr.forEach((node) => fragmentNameToSelectionSet.set(node.name.value, node.selectionSet));
  return fragmentNameToSelectionSet;
}

function expandSelectionNode(
  node: SelectionNode,
  selectionSetsForFragmentDefs: Map<string, SelectionSetNode>,
): readonly SelectionNode[] {
  if (node.kind === 'Field') {
    let newSelectionSet: SelectionSetNode | undefined;
    if (node.selectionSet) {
      newSelectionSet = {
        kind: node.selectionSet.kind,
        loc: node.selectionSet.loc,
        selections: node.selectionSet.selections.flatMap((selectionNode) => expandSelectionNode(
          selectionNode,
          selectionSetsForFragmentDefs,
        )),
      };
    }
    const newField: FieldNode = {
      kind: node.kind,
      loc: node.loc,
      alias: node.alias,
      name: node.name,
      arguments: node.arguments,
      directives: node.directives,
      selectionSet: newSelectionSet,
    };
    return [newField];
  } if (node.kind === 'FragmentSpread') {
    const selectionSetForFragment:
    SelectionSetNode | undefined = selectionSetsForFragmentDefs.get(node.name.value);
    return selectionSetForFragment
      ?.selections
      ?.flatMap((selectionNode) => expandSelectionNode(
        selectionNode,
        selectionSetsForFragmentDefs,
      )) || [];
  } if (node.kind === 'InlineFragment') {
    // Inline Fragment
    return node.selectionSet.selections.flatMap((selectionNode) => expandSelectionNode(
      selectionNode,
      selectionSetsForFragmentDefs,
    ));
  }
  return [];
}

function getReWrittenSelectionSet(
  arr: readonly SelectionNode[],
  selectionSetsForFragmentDefs: Map<string, SelectionSetNode>,
): SelectionNode[] {
  return arr.flatMap((selectionNode) => expandSelectionNode(
    selectionNode,
    selectionSetsForFragmentDefs,
  ));
}

function reWriteASTToSelectionSets(
  query: OperationDefinitionNode,
  document: DocumentNode,
): SelectionSetNode {
  const fragmentDefs: FragmentDefinitionNode[] = getFragmentDefinitions(document);
  const selectionSetsForFragmentDefs:
   Map<string, SelectionSetNode> = getSelectionSetsFromFragmentDefinitions(fragmentDefs);
  const rootQuerySelectionSetNode: SelectionSetNode = query.selectionSet;
  const rootNode: SelectionSetNode = {
    kind: rootQuerySelectionSetNode.kind,
    loc: rootQuerySelectionSetNode.loc,
    selections: getReWrittenSelectionSet(
      rootQuerySelectionSetNode.selections,
      selectionSetsForFragmentDefs,
    ),
  };
  return rootNode;
}

interface SelectionSetVisitor {
  // eslint-disable-next-line no-unused-vars
  onNode: (node: SelectionSetNode) => void,
  onLevelIncrease?: () => void,
}

interface SelectionSetVisitorItem {
  currentNode: SelectionSetNode,
  nodeLevel: number,
}

function traverseSelectionsBreadthFirst(
  root: SelectionSetNode,
  selectionSetVisitor: SelectionSetVisitor,
): void {
  const queue: SelectionSetVisitorItem[] = [];
  let currentLevel = 0;
  queue.push({
    currentNode: root,
    nodeLevel: currentLevel,
  });
  while (queue.length > 0) {
    const currentSelectionAndLevel:
    SelectionSetVisitorItem | undefined = queue.pop();
    if (!currentSelectionAndLevel) {
      process.stdout.write('undefined pushed into queue');
      return;
    }

    if (currentSelectionAndLevel.nodeLevel !== currentLevel
       && selectionSetVisitor.onLevelIncrease) {
      selectionSetVisitor.onLevelIncrease();
      currentLevel += 1;
    }

    const { currentNode } = currentSelectionAndLevel;
    selectionSetVisitor.onNode(currentNode);
    for (let i = 0; i < currentNode.selections.length; i += 1) {
      const selection: SelectionNode = currentNode.selections[i];
      if (selection.kind === 'Field' && selection.selectionSet) {
        queue.push({
          currentNode: selection.selectionSet,
          nodeLevel: currentLevel + 1,
        });
      } else if (selection.kind !== 'Field') {
        process.stdout.write('Dropping non-field selection, re-write AST first');
      }
    }
  }
}

function printFullSelectionSet(root: SelectionSetNode): void {
  traverseSelectionsBreadthFirst(root, {
    onNode: (node: SelectionSetNode) => {
      node.selections.forEach((selection) => {
        if (selection.kind === 'Field') {
          process.stdout.write(`${selection.name.value} `);
        }
      });
      process.stdout.write('\t');
    },
    onLevelIncrease: () => process.stdout.write('\n'),
  });
}

function mapToSortedFieldsByName(
  selectionSetNode: SelectionSetNode,
): FieldNode[] {
  return selectionSetNode.selections.map((selection) => {
    if (selection.kind === 'Field') {
      return selection;
    }
    process.stdout.write('Expected Field, re-write your ast');
    return undefined;
  }).filter((field): field is FieldNode => !!field)
    .sort((a: FieldNode, b: FieldNode) => {
      if (a.name.value < b.name.value) {
        return -1;
      }
      if (a.name.value > b.name.value) {
        return 1;
      }
      return 0;
    });
}

function areFieldNameArraysEqual(
  arr1: FieldNode[],
  arr2: FieldNode[],
): boolean {
  if (arr1.length !== arr2.length) {
    return false;
  }

  for (let i = 0; i < arr1.length; i += 1) {
    if (arr1[i].name.value !== arr2[i].name.value) {
      return false;
    }
  }
  return true;
}

function areSelectionsStructurallyEqual(
  root1: SelectionSetNode,
  root2: SelectionSetNode,
): boolean {
  const queue1: SelectionSetNode[] = [];
  const queue2: SelectionSetNode[] = [];
  queue1.push(root1);
  queue2.push(root2);
  while (queue1.length > 0) {
    const currentNode: SelectionSetNode = queue1.pop()!!;
    const currentNodeFieldSelection:
      FieldNode[] = mapToSortedFieldsByName(currentNode);

    const currentNode2: SelectionSetNode = queue2.pop()!!;
    const currentNode2FieldSelection:
       FieldNode[] = mapToSortedFieldsByName(currentNode2);

    if (!areFieldNameArraysEqual(currentNodeFieldSelection, currentNode2FieldSelection)) {
      process.stdout.write('Field name mismatch\n');
      return false;
    }

    for (let i = 0; i < currentNodeFieldSelection.length; i += 1) {
      process.stdout.write(`pushing field ${currentNodeFieldSelection[i].name.value}\n`);
      if (currentNodeFieldSelection[i].selectionSet) {
        console.log(currentNodeFieldSelection[i].selectionSet);
      }
      if (currentNode2FieldSelection[i].selectionSet) {
        console.log(currentNode2FieldSelection[i].selectionSet);
      }
      let currentFieldHasSelectionSet = false;
      if (currentNodeFieldSelection[i].selectionSet) {
        queue1.push(currentNodeFieldSelection[i].selectionSet!!);
        currentFieldHasSelectionSet = true;
      }

      if (currentNode2FieldSelection[i].selectionSet) {
        queue2.push(currentNode2FieldSelection[i].selectionSet!!);
      } else if (currentFieldHasSelectionSet) {
        process.stdout.write('No selection mismatch\n');
        return false;
      }
    }
  }
  return true;
}

function compare(document: string, document2: string): void {
  const documentNode: DocumentNode = parse(document);
  const documentNode2: DocumentNode = parse(document2);
  const queryNode: OperationDefinitionNode | undefined = getQuery(documentNode);
  const queryNode2: OperationDefinitionNode | undefined = getQuery(documentNode2);
  if (queryNode === undefined || queryNode2 === undefined) {
    return;
  }

  const root1: SelectionSetNode = reWriteASTToSelectionSets(queryNode, documentNode);
  const root2: SelectionSetNode = reWriteASTToSelectionSets(queryNode2, documentNode2);

  process.stdout.write('SelectionSet 1\n');
  printFullSelectionSet(root1);
  process.stdout.write('\n\n');
  process.stdout.write('SelectionSet 2\n');
  printFullSelectionSet(root2);
  const equivalent: boolean = areSelectionsStructurallyEqual(root1, root2);
  process.stdout.write('\n\n');
  process.stdout.write(`Are queries structurally equivalent?\n${equivalent}`);
}

export default compare;
